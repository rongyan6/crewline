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

function resolveActiveServiceMode({ launchd, pidRunning, serviceState } = {}) {
  if (launchd?.running) return 'launchd';
  if (!launchd?.installed && pidRunning) return 'direct';
  return serviceState?.mode ?? (launchd?.installed ? 'launchd' : null);
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

function matchesCrewlineServiceCommand(command = '') {
  const normalized = String(command);
  const importedDistMain = /import\((['"]).*\/crewline\/dist\/main\.js\1\)/.test(normalized);
  return normalized.includes('/crewline/dist/main.js')
    || normalized.includes('/crewline/src/app/main.js')
    || importedDistMain
    || normalized.includes(appMain);
}

export async function listCrewlineMainPids() {
  return await new Promise((resolve, reject) => {
    execFile('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const pids = (stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(.*)$/);
          if (!match) return null;
          return {
            pid: Number(match[1]),
            command: match[2]
          };
        })
        .filter((entry) => entry && Number.isFinite(entry.pid) && entry.pid > 0 && matchesCrewlineServiceCommand(entry.command))
        .map((entry) => entry.pid);
      resolve(pids);
    });
  });
}

async function waitForProcessesToExit(pids, { timeoutMs = 5_000, intervalMs = 100 } = {}) {
  const startedAt = Date.now();
  let remaining = pids.filter((pid) => isProcessRunning(pid));
  while (remaining.length && (Date.now() - startedAt) < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    remaining = remaining.filter((pid) => isProcessRunning(pid));
  }
  return remaining;
}

export async function cleanupStaleCrewlineProcesses({ keepPids = [], includeTrackedPids = false } = {}) {
  const keep = new Set(keepPids.filter(Boolean));
  const pids = new Set(await listCrewlineMainPids());
  if (includeTrackedPids) {
    const trackedPid = await readPidFile().catch(() => null);
    const serviceStatePid = (await readServiceState().catch(() => null))?.pid ?? null;
    if (trackedPid) pids.add(trackedPid);
    if (serviceStatePid) pids.add(serviceStatePid);
  }
  const stale = Array.from(pids).filter((pid) => !keep.has(pid) && pid !== process.pid);
  for (const pid of stale) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  const remaining = await waitForProcessesToExit(stale);
  for (const pid of remaining) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  const forced = remaining.length ? remaining : [];
  await waitForProcessesToExit(forced, { timeoutMs: 1_000, intervalMs: 50 });
  return { stalePids: stale, forceKilledPids: forced };
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

function resolveLaunchdLogPaths(resolvedConfig, paths) {
  const logDir = resolvedConfig.logging?.dir ?? paths.defaultLogDir;
  return {
    logDir,
    stdoutPath: path.join(logDir, 'crewline-service.log'),
    stderrPath: path.join(logDir, 'crewline-service.err.log')
  };
}

async function installOrUpdateLaunchdService({ paths, resolvedConfig }) {
  const { logDir, stdoutPath, stderrPath } = resolveLaunchdLogPaths(resolvedConfig, paths);
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
  await fsp.rm(paths.pidFilePath, { force: true }).catch(() => undefined);
  return {
    ...result,
    pid: status.pid ?? null,
    stdoutPath,
    stderrPath,
    environment
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
  const launchdPlistPath = resolveLaunchAgentPlistPath();
  if (supportsLaunchd()) {
    if (!fs.existsSync(launchdPlistPath)) {
      const result = await installOrUpdateLaunchdService({ paths, resolvedConfig });
      return {
        started: true,
        mode: 'launchd',
        label: result.label,
        action: 'install',
        pid: result.pid,
        logFile: result.stdoutPath
      };
    }
    const status = await readLaunchAgentStatus();
    if (status.running) {
      await cleanupStaleCrewlineProcesses({ keepPids: [status.pid] });
      await fsp.rm(paths.pidFilePath, { force: true }).catch(() => undefined);
      return {
        started: false,
        reason: 'already-running',
        mode: 'launchd',
        label: status.label,
        pid: status.pid ?? null
      };
    }
    const result = await startLaunchAgent(launchdPlistPath);
    const nextStatus = await readLaunchAgentStatus();
    await cleanupStaleCrewlineProcesses({ keepPids: [nextStatus.pid] });
    await fsp.rm(paths.pidFilePath, { force: true }).catch(() => undefined);
    return {
      started: true,
      mode: 'launchd',
      label: result.label,
      action: result.action,
      pid: nextStatus.pid ?? null,
      logFile: nextStatus.command?.sourcePath ? resolveLaunchdLogPaths(resolvedConfig, paths).stdoutPath : undefined
    };
  }
  const logDir = resolvedConfig.logging?.dir ?? paths.defaultLogDir;
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
  if (supportsLaunchd()) {
    if (fs.existsSync(resolveLaunchAgentPlistPath())) {
      try {
        const result = await stopLaunchAgent();
        const cleaned = await cleanupStaleCrewlineProcesses({ keepPids: [], includeTrackedPids: true });
        await fsp.rm(paths.pidFilePath, { force: true }).catch(() => undefined);
        return { stopped: true, mode: 'launchd', label: result.label, cleaned };
      } catch (error) {
        return { stopped: false, reason: 'launchd-stop-failed', error: error?.message ?? String(error) };
      }
    }
    const cleaned = await cleanupStaleCrewlineProcesses({ keepPids: [], includeTrackedPids: true });
    const pid = await readPidFile();
    if ((cleaned.stalePids?.length ?? 0) > 0 || (pid && isProcessRunning(pid))) {
      if (pid && isProcessRunning(pid)) {
        process.kill(pid, 'SIGTERM');
      }
      await fsp.rm(paths.pidFilePath, { force: true }).catch(() => undefined);
      return { stopped: true, mode: 'direct-legacy', pid, cleaned };
    }
    return { stopped: false, reason: 'not-running' };
  }
  const pid = await readPidFile();
  if (!pid || !isProcessRunning(pid)) {
    try { await fsp.rm(paths.pidFilePath, { force: true }); } catch {}
    return { stopped: false, reason: 'not-running' };
  }
  process.kill(pid, 'SIGTERM');
  await fsp.rm(paths.pidFilePath, { force: true });
  const cleaned = await cleanupStaleCrewlineProcesses({ keepPids: [], includeTrackedPids: true });
  return { stopped: true, pid, cleaned };
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
  const result = await installOrUpdateLaunchdService({ paths, resolvedConfig });
  return {
    installed: true,
    ...result
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
  const mode = resolveActiveServiceMode({ launchd, pidRunning, serviceState });
  return {
    running,
    pid: launchd.pid ?? (pidRunning ? pid : null),
    mode,
    managedBy: launchd.installed ? 'launchd' : 'direct',
    autoRestart: launchd.installed,
    startsOnLogin: launchd.installed,
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
