import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { RuntimeBindingStore } from '../../src/state/store/runtime-binding-store.js';
import { ConversationLog } from '../../src/state/store/conversation-log.js';

test('runtime binding store persists per-conversation file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-file-'));
  const store = new RuntimeBindingStore((conversationRef) =>
    path.join(dir, `${conversationRef.channel}-${conversationRef.scope}-${conversationRef.conversationId}.json`)
  );
  await store.set({ channel: 'telegram', scope: 'dm', conversationId: '123' }, { sessionId: 's1', state: 'active' });
  const value = await store.get({ channel: 'telegram', scope: 'dm', conversationId: '123' });
  assert.equal(value.sessionId, 's1');
});

test('conversation log appends jsonl entries to target file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-conversation-log-'));
  const file = path.join(dir, 'conversation.jsonl');
  const log = new ConversationLog();
  await log.append({ path: file, role: 'user', text: 'hello' });
  const entries = await log.readAll(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].role, 'user');
  assert.equal(entries[0].text, 'hello');
});
