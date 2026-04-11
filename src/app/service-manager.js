import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadJsonConfig } from '../config/load-config.js';
import { resolveConfig } from '../config/resolve-config.js';
import { getConfigReadiness } from '../config/check-config-readiness.js';
import { prepareStartupLogFile } from '../obs/log-file-manager.js';
import { readServiceState } from './service-state.js';
import { buildServiceEnvironment } from './service-env.js';
import { resolveRuntimePaths } from './runtime-paths.js';
import {
  buildLaunchAgentPlist,
  installLaunchAgent,
  readLaunchAgentProgramArguments,
  readLaunchAgentStatus,
  resolveLaunchAgentPlistPath,
  startLaunchAgent,
  stopLaunchAgent,
  supportsLaunchd,
  uninstallLaunchAgent
} from './launchd.js';

const appMain = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'main.js');

function ensureRuntimeHome(paths) {
  const { runtimeHome, defaultLogDir } = paths;
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.mkdirSync(defaultLogDir, { recursive: true });
}

function resolveServicePaths(env = process.env) {
  return resolveRuntimePaths(env);
}

export async function readPidFile(env = process.env) {
  const { pidFilePath } = resolveServicePaths(env);
  try {
    const value = await fsp.readFile(pidFilePath, 'utf8');
    const pid = Number(value.trim());
    return Number.isFinite(pid) ? pid : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function listCrewlineMainPids() {
  return await new Promise((resolve, reject) => {
    execFile('pgrep', ['-f', appMain], { encoding: 'utf8' }, (error, stdout) => {
      if (error && error.code !== 1) {
        reject(error);
        return;
      }
      const pids = (stdout ?? '')
        .split(/\s+/)
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
      resolve(pids);
    });
  });
}

export async function cleanupStaleCrewlineProcesses({ keepPids = [] } = {}) {
  const keep = new Set(keepPids.filter(Boolean));
  const pids = await listCrewlineMainPids();
  const stale = pids.filter((pid) => !keep.has(pid) && pid !== process.pid);
  for (const pid of stale) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  return { stalePids: stale };
}

export async function loadUserConfigAndEnv(processEnv = process.env) {
  const { runtimeHome, configPath, systemConfigPath } = resolveServicePaths(processEnv);
  const userConfig = await loadConfig(configPath);
  const systemConfig = await loadJsonConfig(systemConfigPath, { optional: true });
  const resolvedConfig = resolveConfig(userConfig, systemConfig, {}, { configDir: runtimeHome });
  return { userConfig, systemConfig, resolvedConfig, env: {}, configPath, systemConfigPath };
}

export async function ensureConfigReady(env = process.env) {
  const { userConfig, env: resolvedEnv, configPath } = await loadUserConfigAndEnv(env);
  return {
    ...getConfigReadiness(userConfig, resolvedEnv),
    configPath
  };
}

export async function startService() {
  const paths = resolveServicePaths();
  ensureRuntimeHome(paths);
  const readiness = await ensureConfigReady();
  if (!readiness.ok) {
    return {
      started: false,
      reason: 'config-incomplete',
      readiness
    };
  }

  const { resolvedConfig } = await loadUserConfigAndEnv();
  const logDir = resolvedConfig.logging?.dir ?? paths.defaultLogDir;
  const launchdPlistPath = resolveLaunchAgentPlistPath();
  if (supportsLaunchd()) {
    if (fs.existsSync(launchdPlistPath)) {
      const status = await readLaunchAgentStatus();
      if (status.running) {
        await cleanupStaleCrewlineProcesses({ keepPids: [status.pid] });
        return {
          started: false,
          reason: 'already-running',
          mode: 'launchd',
          label: status.label,
          pid: status.pid ?? null
        };
      }
      const { logFile } = await prepareStartupLogFile({
        logDir,
        retentionDays: 7
      });
      const result = await startLaunchAgent(launchdPlistPath);
      const nextStatus = await readLaunchAgentStatus();
      await cleanupStaleCrewlineProcesses({ keepPids: [nextStatus.pid] });
      return {
        started: true,
        mode: 'launchd',
        label: result.label,
        action: result.action,
        pid: nextStatus.pid ?? null,
        logFile
      };
    }
  }
  const existingPid = await readPidFile();
  if (isProcessRunning(existingPid)) {
    return { started: false, reason: 'already-running', pid: existingPid };
  }
  const { logFile } = await prepareStartupLogFile({
    logDir,
    retentionDays: 7
  });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [appMain], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...buildServiceEnvironment({ ...process.env, CREWLINE_SERVICE_MODE: 'direct' }),
      CREWLINE_SERVICE_MODE: 'direct'
    }
  });
  child.unref();
  await fsp.writeFile(paths.pidFilePath, `${child.pid}
`, 'utf8');
  return { started: true, pid: child.pid, logFile };
}

export async function stopService() {
  const paths = resolveServicePaths();
  if (supportsLaunchd() && fs.existsSync(resolveLaunchAgentPlistPath())) {
    try {
      const result = await stopLaunchAgent();
      await cleanupStaleCrewlineProcesses({ keepPids: [] });
      await fsp.rm(paths.pidFilePath, { force: true }).catch(() => undefined);
      return { stopped: true, mode: 'launchd', label: result.label };
    } catch (error) {
      return { stopped: false, reason: 'launchd-stop-failed', error: error?.message ?? String(error) };
    }
  }
  const pid = await readPidFile();
  if (!pid || !isProcessRunning(pid)) {
    try { await fsp.rm(paths.pidFilePath, { force: true }); } catch {}
    return { stopped: false, reason: 'not-running' };
  }
  process.kill(pid, 'SIGTERM');
  await fsp.rm(paths.pidFilePath, { force: true });
  return { stopped: true, pid };
}

export async function restartService() {
  const stopped = await stopService();
  const started = await startService();
  return { stopped, started };
}

export async function installService() {
  const paths = resolveServicePaths();
  ensureRuntimeHome(paths);
  if (!supportsLaunchd()) {
    return { installed: false, reason: 'launchd-unsupported', platform: process.platform };
  }
  const readiness = await ensureConfigReady();
  if (!readiness.ok) {
    return { installed: false, reason: 'config-incomplete', readiness };
  }
  const { resolvedConfig } = await loadUserConfigAndEnv();
  const { logDir, stdoutPath, stderrPath } = {
    logDir: resolvedConfig.logging?.dir ?? paths.defaultLogDir,
    stdoutPath: path.join(resolvedConfig.logging?.dir ?? paths.defaultLogDir, 'crewline-service.log'),
    stderrPath: path.join(resolvedConfig.logging?.dir ?? paths.defaultLogDir, 'crewline-service.err.log')
  };
  fs.mkdirSync(logDir, { recursive: true });
  const environment = buildServiceEnvironment(process.env);
  const plist = buildLaunchAgentPlist({
    programArguments: [process.execPath, appMain],
    workingDirectory: process.cwd(),
    stdoutPath,
    stderrPath,
    environment,
    comment: 'Crewline background gateway service'
  });
  const result = await installLaunchAgent({ plist });
  const status = await readLaunchAgentStatus();
  await cleanupStaleCrewlineProcesses({ keepPids: [status.pid] });
  return {
    installed: true,
    ...result,
    stdoutPath,
    stderrPath,
    environment
  };
}

export async function uninstallService() {
  if (!supportsLaunchd()) {
    return { uninstalled: false, reason: 'launchd-unsupported', platform: process.platform };
  }
  const result = await uninstallLaunchAgent();
  return { uninstalled: true, ...result };
}

export async function getServiceStatus() {
  const paths = resolveServicePaths();
  const pid = await readPidFile();
  const serviceState = await readServiceState();
  const launchd = supportsLaunchd()
    ? await readLaunchAgentStatus()
    : { installed: false, loaded: false, running: false };
  const command = supportsLaunchd() ? await readLaunchAgentProgramArguments().catch(() => null) : null;
  const pidRunning = isProcessRunning(pid);
  const running = launchd.running || (!launchd.installed && pidRunning);
  return {
    running,
    pid: launchd.pid ?? (pidRunning ? pid : null),
    command,
    paths,
    launchd,
    serviceState
  };
}

export function formatReadinessMessage(readiness) {
  const lines = [
    'Crewline 配置未完成，暂时无法启动。',
    `请检查：${readiness.configPath}`,
    ''
  ];
  for (const issue of readiness.issues) lines.push(`- ${issue}`);
  if (readiness.suggestions.length) {
    lines.push('', '建议：');
    for (const suggestion of readiness.suggestions) lines.push(`- ${suggestion}`);
  }
  return lines.join('\n');
}
