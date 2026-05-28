import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildRunTurnArgs,
  findCrewlinePackageRoot,
  resolveBundledAcpxCommand,
  sanitizeSessionName
} from '../../src/runtime/acp/acpx-client.js';

test('sanitizeSessionName normalizes unsafe characters', () => {
  assert.equal(sanitizeSessionName('telegram:dm:1/2 3'), 'telegram:dm:1_2_3');
});

test('findCrewlinePackageRoot resolves the current package root', () => {
  assert.equal(findCrewlinePackageRoot(), process.cwd());
});

test('resolveBundledAcpxCommand points at crewline-installed acpx binary', () => {
  const expectedBasename = process.platform === 'win32' ? 'acpx.cmd' : 'acpx';
  const command = resolveBundledAcpxCommand();

  assert.equal(path.basename(command), expectedBasename);
  assert.equal(path.dirname(command), path.join(process.cwd(), 'node_modules', '.bin'));
});

test('buildRunTurnArgs uses a finite acpx queue ttl by default', () => {
  const args = buildRunTurnArgs({
    cwd: '/tmp/project',
    agentId: 'codex',
    runtimeSessionName: 'telegram:dm:1',
    messageText: 'hi'
  });

  assert.deepEqual(args.slice(0, 6), ['--cwd', '/tmp/project', '--format', 'json', '--ttl', '300']);
  assert.equal(args.at(-1), 'hi');
});

test('buildRunTurnArgs accepts an explicit acpx queue ttl override', () => {
  const args = buildRunTurnArgs({
    cwd: '/tmp/project',
    agentId: 'claude',
    runtimeSessionName: 'feishu:dm:1',
    messageText: 'hello',
    queueTtlSeconds: 60
  });

  assert.equal(args[5], '60');
});

test('buildRunTurnArgs passes an explicit ACP model before the agent command', () => {
  const args = buildRunTurnArgs({
    cwd: '/tmp/project',
    agentId: 'codex',
    runtimeSessionName: 'telegram:dm:1',
    messageText: 'hi',
    model: 'gpt-5.5[medium]'
  });

  assert.deepEqual(args.slice(6, 8), ['--model', 'gpt-5.5[medium]']);
  assert.equal(args.at(-4), 'codex');
});

test('buildRunTurnArgs treats null acpx queue ttl as the default', () => {
  const args = buildRunTurnArgs({
    cwd: '/tmp/project',
    agentId: 'claude',
    runtimeSessionName: 'feishu:dm:1',
    messageText: 'hello',
    queueTtlSeconds: null
  });

  assert.equal(args[5], '300');
});
