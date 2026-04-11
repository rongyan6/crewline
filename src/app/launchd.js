import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const launchAgentLabel = 'ai.crewline.gateway';
const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const throttleIntervalSeconds = 1;
const umaskDecimal = 0o077;

function plistEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function execLaunchctl(args) {
  return new Promise((resolve, reject) => {
    execFile('launchctl', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') {
        reject(error);
        return;
      }
      resolve({
        code: error?.code ?? 0,
        stdout,
        stderr
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function supportsLaunchd() {
  return process.platform === 'darwin';
}

export function resolveLaunchAgentPlistPath() {
  return path.join(launchAgentsDir, `${launchAgentLabel}.plist`);
}

function parseLaunchctlPrint(output) {
  const pidMatch = output.match(/\bpid = (\d+)/);
  const stateMatch = output.match(/\bstate = ([^\n]+)/);
  const exitStatusMatch = output.match(/\blast exit status = ([^\n]+)/i);
  const exitReasonMatch = output.match(/\blast exit reason = ([^\n]+)/i);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : null,
    state: stateMatch?.[1]?.trim() ?? null,
    lastExitStatus: exitStatusMatch?.[1]?.trim() ?? null,
    lastExitReason: exitReasonMatch?.[1]?.trim() ?? null
  };
}

export async function readLaunchAgentProgramArguments(plistPath = resolveLaunchAgentPlistPath()) {
  try {
    const plist = await fs.readFile(plistPath, 'utf8');
    const programMatch = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i);
    if (!programMatch) return null;
    const programArguments = Array.from(programMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/gi))
      .map((match) => match[1]?.trim())
      .filter(Boolean);
    const workingDirectory = plist.match(/<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/i)?.[1]?.trim();
    const envMatch = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/i);
    const environment = {};
    if (envMatch) {
      for (const pair of envMatch[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gi)) {
        const key = pair[1]?.trim();
        const value = pair[2]?.trim();
        if (key) environment[key] = value ?? '';
      }
    }
    return {
      programArguments,
      workingDirectory: workingDirectory || undefined,
      environment: Object.keys(environment).length ? environment : undefined,
      sourcePath: plistPath
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function buildLaunchAgentPlist({ programArguments, stdoutPath, stderrPath, workingDirectory, environment = {}, comment } = {}) {
  const argsXml = programArguments.map((arg) => `\n      <string>${plistEscape(arg)}</string>`).join('');
  const envEntries = Object.entries(environment)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => `\n      <key>${plistEscape(key)}</key>\n      <string>${plistEscape(value)}</string>`)
    .join('');
  const envXml = envEntries
    ? `\n    <key>EnvironmentVariables</key>\n    <dict>${envEntries}\n    </dict>`
    : '';
  const commentXml = comment?.trim()
    ? `\n    <key>Comment</key>\n    <string>${plistEscape(comment.trim())}</string>`
    : '';
  const workingDirectoryXml = workingDirectory
    ? `\n    <key>WorkingDirectory</key>\n    <string>${plistEscape(workingDirectory)}</string>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${launchAgentLabel}</string>
    ${commentXml}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${throttleIntervalSeconds}</integer>
    <key>Umask</key>
    <integer>${umaskDecimal}</integer>
    <key>ProgramArguments</key>
    <array>${argsXml}
    </array>
    ${workingDirectoryXml}
    <key>StandardOutPath</key>
    <string>${plistEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(stderrPath)}</string>${envXml}
  </dict>
</plist>
`;
}

export async function installLaunchAgent({ plist, plistPath = resolveLaunchAgentPlistPath() }) {
  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.writeFile(plistPath, plist, 'utf8');
  await execLaunchctl(['bootout', `gui/${process.getuid()}/${launchAgentLabel}`]).catch(() => null);
  const result = await execLaunchctl(['bootstrap', `gui/${process.getuid()}`, plistPath]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'launchctl bootstrap failed');
  }
  await waitForLaunchAgentStatus((status) => status.loaded === true, { timeoutMs: 5_000 });
  return { ok: true, label: launchAgentLabel, plistPath };
}

export async function uninstallLaunchAgent(plistPath = resolveLaunchAgentPlistPath()) {
  await execLaunchctl(['bootout', `gui/${process.getuid()}/${launchAgentLabel}`]).catch(() => null);
  await waitForLaunchAgentStatus((status) => status.loaded === false, { timeoutMs: 5_000 }).catch(() => null);
  await fs.rm(plistPath, { force: true });
  return { ok: true, label: launchAgentLabel, plistPath };
}

export async function startLaunchAgent(plistPath = resolveLaunchAgentPlistPath()) {
  const bootstrap = await execLaunchctl(['bootstrap', `gui/${process.getuid()}`, plistPath]);
  if (bootstrap.code === 0) {
    await waitForLaunchAgentStatus((status) => status.running === true, { timeoutMs: 5_000 });
    return { ok: true, label: launchAgentLabel, action: 'bootstrap' };
  }
  const result = await execLaunchctl(['kickstart', '-k', `gui/${process.getuid()}/${launchAgentLabel}`]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'launchctl kickstart failed');
  }
  await waitForLaunchAgentStatus((status) => status.running === true, { timeoutMs: 5_000 });
  return { ok: true, label: launchAgentLabel, action: 'kickstart' };
}

export async function stopLaunchAgent() {
  const result = await execLaunchctl(['bootout', `gui/${process.getuid()}/${launchAgentLabel}`]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'launchctl bootout failed');
  }
  await waitForLaunchAgentStatus((status) => status.loaded === false, { timeoutMs: 5_000 });
  return { ok: true, label: launchAgentLabel };
}

export async function readLaunchAgentStatus() {
  const plistPath = resolveLaunchAgentPlistPath();
  const command = await readLaunchAgentProgramArguments(plistPath);
  const result = await execLaunchctl(['print', `gui/${process.getuid()}/${launchAgentLabel}`]);
  if (result.code !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || null;
    return {
      installed: Boolean(command),
      loaded: false,
      running: false,
      label: launchAgentLabel,
      plistPath,
      command,
      detail
    };
  }
  const output = result.stdout || result.stderr || '';
  const parsed = parseLaunchctlPrint(output);
  const running = parsed.state?.toLowerCase() === 'running' || Number.isFinite(parsed.pid);
  return {
    installed: true,
    loaded: true,
    running,
    label: launchAgentLabel,
    plistPath,
    command,
    pid: parsed.pid,
    state: parsed.state,
    lastExitStatus: parsed.lastExitStatus,
    lastExitReason: parsed.lastExitReason
  };
}

export async function waitForLaunchAgentStatus(
  predicate,
  { timeoutMs = 5_000, intervalMs = 200, readStatus = readLaunchAgentStatus } = {}
) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const status = await readStatus();
    if (predicate(status)) return status;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for launch agent state after ${timeoutMs}ms`);
}
