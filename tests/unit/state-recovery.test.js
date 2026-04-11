import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { shouldRecreateSession } from '../../src/state/recovery/recovery-policy.js';
import { compactState } from '../../src/state/recovery/compaction.js';
import { ErrorCodes } from '../../src/shared/errors/error-codes.js';

test('shouldRecreateSession only recreates on runtime session loss', () => {
  assert.equal(shouldRecreateSession({ ok: false, errorCode: ErrorCodes.RUNTIME_SESSION_LOST }), true);
  assert.equal(shouldRecreateSession({ ok: false, errorCode: ErrorCodes.RUNTIME_TURN_FAILED }), false);
  assert.equal(shouldRecreateSession({ ok: true }), false);
});

test('compactState migrates legacy binding fields and cleans malformed conversation log lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-compact-'));
  const bindingDir = path.join(dir, 'bindings', 'telegram', 'dm');
  const conversationDir = path.join(dir, 'conversations', 'telegram', 'dm');
  await fs.mkdir(bindingDir, { recursive: true });
  await fs.mkdir(conversationDir, { recursive: true });

  const bindingFile = path.join(bindingDir, '123.json');
  const logFile = path.join(conversationDir, '123.jsonl');

  await fs.writeFile(bindingFile, JSON.stringify({
    sessionId: 'session_1',
    state: 'active',
    turnLogPath: '/tmp/legacy-turn-log.jsonl'
  }, null, 2));
  await fs.writeFile(logFile, [
    JSON.stringify({ role: 'user', text: 'hello' }),
    '',
    'not-json',
    JSON.stringify({ role: 'assistant', text: 'hi' })
  ].join('\n'));

  const result = await compactState({ dataDir: dir });
  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.equal(result.compactedBindings, 1);
  assert.equal(result.compactedLogs, 1);
  assert.equal(result.droppedLogLines, 1);

  const binding = JSON.parse(await fs.readFile(bindingFile, 'utf8'));
  assert.equal(binding.bindingState, 'active');
  assert.equal(binding.state, 'active');
  assert.equal(binding.turnLogPath, undefined);
  assert.match(binding.conversationLogPath, /conversations\/telegram\/dm\/123\.jsonl$/);

  const logLines = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(logLines.length, 2);
  assert.equal(logLines[0].role, 'user');
  assert.equal(logLines[1].role, 'assistant');
});
