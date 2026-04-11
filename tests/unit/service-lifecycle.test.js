import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  buildLaunchAgentPlist,
  readLaunchAgentProgramArguments,
  waitForLaunchAgentStatus
} from '../../src/app/launchd.js';
import { buildServiceEnvironment } from '../../src/app/service-env.js';
import { resolveRuntimePaths } from '../../src/app/runtime-paths.js';
import { healthcheck } from '../../src/obs/healthcheck.js';

test('launchd plist includes launch controls and round-trips command metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-launchd-'));
  const plistPath = path.join(dir, 'ai.crewline.gateway.plist');
  const plist = buildLaunchAgentPlist({
    programArguments: ['/usr/bin/node', '/tmp/main.js'],
    stdoutPath: '/tmp/crewline.log',
    stderrPath: '/tmp/crewline.err.log',
    workingDirectory: '/tmp/crewline',
    environment: {
      CREWLINE_SERVICE_MODE: 'launchd',
      CREWLINE_RUNTIME_HOME: '/tmp/crewline-home'
    },
    comment: 'Crewline background gateway service'
  });

  await fs.writeFile(plistPath, plist, 'utf8');
  const parsed = await readLaunchAgentProgramArguments(plistPath);

  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>1<\/integer>/);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.equal(parsed.programArguments[0], '/usr/bin/node');
  assert.equal(parsed.workingDirectory, '/tmp/crewline');
  assert.equal(parsed.environment.CREWLINE_RUNTIME_HOME, '/tmp/crewline-home');
});

test('service environment and runtime paths honor explicit runtime home', () => {
  const env = {
    HOME: '/Users/tester',
    PATH: '/usr/bin:/bin',
    CREWLINE_RUNTIME_HOME: '/tmp/crewline-home',
    HTTPS_PROXY: 'http://127.0.0.1:7890'
  };

  const paths = resolveRuntimePaths(env);
  const serviceEnv = buildServiceEnvironment(env);

  assert.equal(paths.runtimeHome, '/tmp/crewline-home');
  assert.equal(paths.configPath, '/tmp/crewline-home/crewline.json');
  assert.equal(serviceEnv.CREWLINE_CONFIG_PATH, '/tmp/crewline-home/crewline.json');
  assert.equal(serviceEnv.CREWLINE_LOG_DIR, '/tmp/crewline-home/logs');
  assert.equal(serviceEnv.HTTPS_PROXY, 'http://127.0.0.1:7890');
});

test('healthcheck reports binding and conversation log counts and fails on failed service state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-health-'));
  await fs.mkdir(path.join(dir, 'bindings', 'telegram', 'dm'), { recursive: true });
  await fs.mkdir(path.join(dir, 'conversations', 'telegram', 'dm'), { recursive: true });
  await fs.writeFile(path.join(dir, 'bindings', 'telegram', 'dm', '123.json'), '{}', 'utf8');
  await fs.writeFile(path.join(dir, 'conversations', 'telegram', 'dm', '123.jsonl'), '{}\n', 'utf8');

  const result = await healthcheck({
    runtimeGateway: { status: async () => ({ ok: true, backend: 'acpx' }) },
    channelHost: { plugins: new Map() },
    stateStore: { dataDir: dir },
    metrics: { snapshot: () => ({ counters: {}, timings: {}, updatedAt: 'now' }) },
    serviceState: { status: 'failed' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.stateStore.runtimeBindings, 1);
  assert.equal(result.stateStore.conversationLogs, 1);
});

test('waitForLaunchAgentStatus resolves when predicate eventually matches', async () => {
  const statuses = [
    { loaded: false, running: false },
    { loaded: false, running: false },
    { loaded: true, running: true }
  ];
  let index = 0;
  const result = await waitForLaunchAgentStatus(
    (status) => status.loaded === true,
    {
      timeoutMs: 50,
      intervalMs: 1,
      readStatus: async () => statuses[Math.min(index++, statuses.length - 1)]
    }
  );
  assert.equal(result.loaded, true);
  assert.equal(result.running, true);
});
