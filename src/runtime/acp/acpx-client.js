import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntimeHandle } from './runtime-handle.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ACPX_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_ACPX_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_ACPX_QUEUE_TTL_SECONDS = 300;
const FALLBACK_ACPX_PACKAGE = 'acpx@0.10.0';

function findCrewlinePackageRoot(startDir = moduleDir) {
  let current = startDir;
  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson?.name === 'crewline') {
        return current;
      }
    } catch {
      // Keep walking upward until we find Crewline's package root.
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveBundledAcpxCommand() {
  const packageRoot = findCrewlinePackageRoot();
  if (!packageRoot) return null;
  return path.join(
    packageRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'acpx.cmd' : 'acpx'
  );
}

function sanitizeSessionName(value) {
  return String(value).replace(/[^a-zA-Z0-9._:-]/g, '_');
}

function commandCandidates() {
  const explicit = process.env.CREWLINE_ACPX_BIN?.trim();
  if (explicit) return [{ command: explicit, prefix: [] }];
  const bundled = resolveBundledAcpxCommand();
  return [
    ...(bundled ? [{ command: bundled, prefix: [] }] : []),
    { command: 'acpx', prefix: [] },
    { command: 'npx', prefix: ['-y', FALLBACK_ACPX_PACKAGE] }
  ];
}

function createAcpxTimeoutError(commandLabel, timeoutMs) {
  const error = new Error(`acpx command timed out after ${timeoutMs}ms: ${commandLabel}`);
  error.code = 'ETIMEDOUT';
  error.command = commandLabel;
  error.timeoutMs = timeoutMs;
  return error;
}

function runProcess(command, args, { cwd, timeoutMs = DEFAULT_ACPX_COMMAND_TIMEOUT_MS, rejectOnNonZero = true }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'pipe' });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(createAcpxTimeoutError(command, timeoutMs));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0 && rejectOnNonZero) {
        reject(new Error(err || out || `acpx exited with code ${code}`));
        return;
      }
      resolve({ code, stdout: out.trim(), stderr: err.trim() });
    });
  });
}

async function runAcpx(args, options) {
  let lastError;
  for (const candidate of commandCandidates()) {
    try {
      return await runProcess(candidate.command, [...candidate.prefix, ...args], options);
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') {
        continue;
      }
    }
  }
  throw lastError;
}

async function runAcpxStreaming(args, { cwd, timeoutMs = 120_000, onChunk } = {}) {
  let lastError;
  for (const candidate of commandCandidates()) {
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(candidate.command, [...candidate.prefix, ...args], { cwd, stdio: 'pipe' });
        const stderr = [];
        const lines = [];
        let buffer = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(createAcpxTimeoutError([candidate.command, ...candidate.prefix].join(' '), timeoutMs));
        }, timeoutMs);

        const flushLine = (line) => {
          if (!line.trim()) return;
          lines.push(line);
          try {
            const message = JSON.parse(line);
            const update = message?.params?.update;
            if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
              onChunk?.(update.content.text);
            }
          } catch {
            // ignore non-json lines
          }
        };

        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          while (buffer.includes('\n')) {
            const idx = buffer.indexOf('\n');
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            flushLine(line);
          }
        });
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (buffer.trim()) flushLine(buffer.trim());
          const err = Buffer.concat(stderr).toString('utf8').trim();
          let stopReason = null;
          for (const line of lines) {
            try {
              const message = JSON.parse(line);
              if (message?.result?.stopReason) stopReason = message.result.stopReason;
            } catch {}
          }
          resolve({ code, stderr: err, lines, stopReason });
        });
      });
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') continue;
    }
  }
  throw lastError;
}

function extractFinalText(lines) {
  let text = '';
  for (const line of lines) {
    try {
      const message = JSON.parse(line);
      const update = message?.params?.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        text += update.content.text;
      }
    } catch {}
  }
  return text.trim();
}

function parseJsonRecord(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildPermissionArgs(approvalMode = 'default') {
  switch (approvalMode) {
    case 'deny-all':
      return ['--deny-all', '--non-interactive-permissions', 'deny'];
    case 'approve-reads':
      return ['--approve-reads', '--non-interactive-permissions', 'fail'];
    case 'approve-all':
      return ['--approve-all', '--non-interactive-permissions', 'deny'];
    case 'default':
    default:
      return ['--approve-all', '--non-interactive-permissions', 'deny'];
  }
}

function buildModelArgs(model) {
  if (typeof model !== 'string') return [];
  const trimmed = model.trim();
  return trimmed ? ['--model', trimmed] : [];
}

function normalizeQueueTtlSeconds(value = DEFAULT_ACPX_QUEUE_TTL_SECONDS) {
  if (value === undefined || value === null || value === '') return DEFAULT_ACPX_QUEUE_TTL_SECONDS;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return DEFAULT_ACPX_QUEUE_TTL_SECONDS;
  return Math.floor(number);
}

function buildRunTurnArgs({
  cwd,
  agentId,
  runtimeSessionName,
  messageText,
  approvalMode = 'default',
  model,
  queueTtlSeconds = DEFAULT_ACPX_QUEUE_TTL_SECONDS
}) {
  return [
    '--cwd', cwd,
    '--format', 'json',
    '--ttl', String(normalizeQueueTtlSeconds(queueTtlSeconds)),
    ...buildModelArgs(model),
    ...buildPermissionArgs(approvalMode),
    agentId,
    '-s', runtimeSessionName,
    messageText
  ];
}

export class AcpxClient {
  constructor({
    commandTimeoutMs = DEFAULT_ACPX_COMMAND_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_ACPX_TURN_TIMEOUT_MS,
    queueTtlSeconds = DEFAULT_ACPX_QUEUE_TTL_SECONDS
  } = {}) {
    this.commandTimeoutMs = commandTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.queueTtlSeconds = normalizeQueueTtlSeconds(queueTtlSeconds);
  }

  async ensureSession({ agentId, cwd = process.cwd(), sessionName }) {
    const name = sanitizeSessionName(sessionName ?? agentId);
    await runAcpx(['--cwd', cwd, agentId, 'sessions', 'ensure', '--name', name], {
      cwd,
      timeoutMs: this.commandTimeoutMs
    });
    return createRuntimeHandle({
      runtimeSessionName: name,
      sessionKey: `${agentId}:${name}`
    });
  }

  async runTurn({ agentId, runtimeHandle, cwd = process.cwd(), messageText, onChunk, approvalMode = 'default', model }) {
    const result = await runAcpxStreaming(
      buildRunTurnArgs({
        cwd,
        agentId,
        runtimeSessionName: runtimeHandle.runtimeSessionName,
        messageText,
        approvalMode,
        model,
        queueTtlSeconds: this.queueTtlSeconds
      }),
      { cwd, onChunk, timeoutMs: this.turnTimeoutMs }
    );
    const text = extractFinalText(result.lines);
    if (result.code !== 0 && !text) {
      throw new Error(result.stderr || `acpx exited with code ${result.code}`);
    }
    return {
      text,
      runtimeHandle,
      exitCode: result.code,
      stderr: result.stderr,
      stopReason: result.stopReason
    };
  }

  async resumeSession({ agentId, runtimeHandle, cwd = process.cwd() } = {}) {
    if (!agentId || !runtimeHandle?.runtimeSessionName) {
      return { ok: false, reason: 'missing' };
    }
    const name = sanitizeSessionName(runtimeHandle.runtimeSessionName);
    const result = await runAcpx(
      ['--cwd', cwd, '--format', 'json', agentId, 'sessions', 'show', name],
      { cwd, rejectOnNonZero: false, timeoutMs: this.commandTimeoutMs }
    );
    const payload = parseJsonRecord(result.stdout || result.stderr);
    if (payload?.schema === 'acpx.session.v1' && payload.closed !== true) {
      return {
        ok: true,
        runtimeHandle: createRuntimeHandle({
          runtimeSessionName: payload.name ?? name,
          sessionKey: `${agentId}:${payload.name ?? name}`,
          opaqueState: {
            acpSessionId: payload.acpSessionId ?? null,
            pid: payload.pid ?? null
          }
        }),
        metadata: {
          createdAt: payload.createdAt ?? null,
          lastUsedAt: payload.lastUsedAt ?? null
        }
      };
    }
    if (payload?.error?.message && /No cwd session|not found|closed/i.test(payload.error.message)) {
      return { ok: false, reason: 'missing' };
    }
    if (result.code !== 0) {
      throw new Error(payload?.error?.message || result.stderr || result.stdout || `acpx exited with code ${result.code}`);
    }
    return { ok: false, reason: 'missing' };
  }

  async status({ agentId, runtimeHandle, cwd = process.cwd() } = {}) {
    if (!agentId && !runtimeHandle) {
      return {
        ok: true,
        available: true,
        backend: 'acpx'
      };
    }
    if (!agentId || !runtimeHandle?.runtimeSessionName) {
      return { ok: false, reason: 'missing' };
    }
    const result = await runAcpx(
      ['--cwd', cwd, '--format', 'json', agentId, 'status', '-s', runtimeHandle.runtimeSessionName],
      { cwd, rejectOnNonZero: false, timeoutMs: this.commandTimeoutMs }
    );
    const payload = parseJsonRecord(result.stdout || result.stderr);
    if (result.code !== 0) {
      return {
        ok: false,
        reason: payload?.error?.message ?? result.stderr ?? result.stdout ?? `acpx exited with code ${result.code}`
      };
    }
    return {
      ok: true,
      payload
    };
  }

  async cancel({ agentId, runtimeHandle, cwd = process.cwd() } = {}) {
    if (!agentId || !runtimeHandle?.runtimeSessionName) {
      return { ok: false, reason: 'missing' };
    }
    const result = await runAcpx(
      ['--cwd', cwd, agentId, 'cancel', '-s', runtimeHandle.runtimeSessionName],
      { cwd, rejectOnNonZero: false, timeoutMs: this.commandTimeoutMs }
    );
    if (result.code !== 0) {
      return {
        ok: false,
        reason: result.stderr || result.stdout || `acpx exited with code ${result.code}`
      };
    }
    return { ok: true };
  }

  async close({ agentId, runtimeHandle, cwd = process.cwd() } = {}) {
    if (!agentId || !runtimeHandle?.runtimeSessionName) return { ok: true, skipped: true };
    await runAcpx(['--cwd', cwd, agentId, 'sessions', 'close', runtimeHandle.runtimeSessionName], {
      cwd,
      timeoutMs: this.commandTimeoutMs
    });
    return { ok: true };
  }
}

export {
  DEFAULT_ACPX_QUEUE_TTL_SECONDS,
  buildRunTurnArgs,
  runAcpx,
  sanitizeSessionName,
  extractFinalText,
  findCrewlinePackageRoot,
  resolveBundledAcpxCommand
};
