#!/usr/bin/env node
import {
  startService,
  stopService,
  restartService,
  installService,
  uninstallService,
  getServiceStatus,
  ensureConfigReady,
  formatReadinessMessage
} from '../src/app/service-manager.js';
import { healthcheck } from '../src/obs/healthcheck.js';
import { readServiceState } from '../src/app/service-state.js';
import { readJson } from '../src/shared/utils/jsonl.js';
import { runWechatLoginCommand } from '../src/app/wechat-command.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveRuntimePaths } from '../src/app/runtime-paths.js';
import { resolveDoctorScript } from '../src/app/doctor-command.js';
import { initializeCrewlineProject } from '../src/app/init-command.js';
import { formatHelp } from '../src/app/help-command.js';

const command = process.argv[2] ?? 'start';
const extraArgs = process.argv.slice(3);
const subcommand = extraArgs[0] ?? null;
const runtimePaths = resolveRuntimePaths();

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function printHelp() {
  console.log(formatHelp({
    defaultRuntimeHome: path.join(process.env.HOME ?? '~', '.crewline')
  }));
}

async function runNodeScript(scriptPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      env: process.env
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

async function main() {
  if (command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'help': {
      printHelp();
      return;
    }
    case 'init': {
      const result = await initializeCrewlineProject({
        cwd: process.cwd(),
        force: hasFlag('--force')
      });
      console.log(JSON.stringify({
        ok: true,
        runtimeHome: result.runtimeHome,
        configPath: result.configPath,
        envPath: result.envPath,
        written: result.written,
        skipped: result.skipped,
        next: [
          'Edit crewline/crewline.json to add at least one channel.',
          'Fill crewline/.env with the required secrets.',
          'Run: crewline doctor'
        ]
      }, null, 2));
      return;
    }
    case 'wechat': {
      if (subcommand === 'login') {
        const result = await runWechatLoginCommand();
        console.log(JSON.stringify({
          ok: result.ok,
          accountId: result.accountId ?? null,
          userId: result.userId ?? null,
          serviceReloaded: result.serviceReloaded === true
        }, null, 2));
        return;
      }
      console.log('Usage: crewline wechat <login>');
      process.exitCode = 1;
      return;
    }
    case 'start': {
      const result = await startService();
      if (result.started) {
        console.log(`Crewline started${result.pid ? ` (pid: ${result.pid})` : ''}`);
        if (result.mode) console.log(`mode: ${result.mode}`);
        if (result.label) console.log(`label: ${result.label}`);
        if (result.logFile) console.log(`log: ${result.logFile}`);
        if (result.mode === 'launchd' && result.action === 'install') {
          console.log('note: launchd service was installed automatically for this start');
        }
        return;
      }
      if (result.reason === 'already-running') {
        console.log(`Crewline is already running (pid: ${result.pid})`);
        return;
      }
      if (result.reason === 'config-incomplete') {
        console.log(formatReadinessMessage(result.readiness));
        process.exitCode = 2;
        return;
      }
      process.exitCode = 1;
      return;
    }
    case 'stop': {
      const result = await stopService();
      if (result.stopped) {
        console.log(`Crewline stopped (pid: ${result.pid})`);
      } else {
        console.log('Crewline is not running.');
      }
      return;
    }
    case 'restart': {
      const result = await restartService();
      if (result.started?.started) {
        console.log('Crewline restarted.');
        console.log(`pid: ${result.started.pid}`);
        if (result.started.mode) console.log(`mode: ${result.started.mode}`);
        return;
      }
      if (result.started?.reason === 'config-incomplete') {
        console.log(formatReadinessMessage(result.started.readiness));
        process.exitCode = 2;
        return;
      }
      process.exitCode = 1;
      return;
    }
    case 'install': {
      const result = await installService();
      if (result.installed) {
        console.log(`Crewline launchd installed: ${result.label}`);
        console.log(`plist: ${result.plistPath}`);
        console.log(`stdout: ${result.stdoutPath}`);
        console.log(`stderr: ${result.stderrPath}`);
        return;
      }
      if (result.reason === 'config-incomplete') {
        console.log(formatReadinessMessage(result.readiness));
        process.exitCode = 2;
        return;
      }
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }
    case 'uninstall': {
      const result = await uninstallService();
      if (result.uninstalled) {
        console.log(`Crewline launchd uninstalled: ${result.label}`);
        return;
      }
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }
    case 'status': {
      const status = await getServiceStatus();
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    case 'health': {
      const readiness = await ensureConfigReady();
      const status = await getServiceStatus();
      const serviceState = await readServiceState();
      const metricsPath = path.join(status.serviceState?.runtimeHome ?? runtimePaths.runtimeHome, 'metrics', 'snapshot.json');
      const metrics = await readJson(metricsPath, null);
      const report = await healthcheck({
        runtimeGateway: {
          status: async () => ({
            ok: Boolean(status.running),
            backend: 'acpx',
            pid: status.pid,
            launchd: status.launchd?.loaded ?? false
          })
        },
        channelHost: { plugins: new Map() },
        stateStore: { dataDir: runtimePaths.runtimeHome },
        metrics: { snapshot: () => metrics },
        serviceState: {
          ...serviceState,
          readinessOk: readiness.ok,
          launchd: status.launchd,
          command: status.command,
          runtimePaths: status.paths
        }
      });
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok || !readiness.ok) process.exitCode = 1;
      return;
    }
    case 'doctor': {
      const doctorScript = resolveDoctorScript(subcommand);
      if (doctorScript) {
        await runNodeScript(doctorScript);
        return;
      }
      const readiness = await ensureConfigReady();
      if (readiness.ok) {
        console.log('Crewline 配置完整，可以启动。');
      } else {
        console.log(formatReadinessMessage(readiness));
        process.exitCode = 2;
      }
      return;
    }
    default:
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
