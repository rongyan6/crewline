import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { bootstrap } from '../../src/app/bootstrap.js';

class FakeTelegramApi {
  constructor() {
    this.sent = [];
  }
  async sendChatAction() { return { ok: true }; }
  async sendMessage(payload) {
    this.sent.push(payload);
    return { message_id: this.sent.length };
  }
  async streamText({ chunks }) {
    let text = '';
    for await (const chunk of chunks) text += chunk;
    this.sent.push({ stream: true, text });
    return { messageId: 999, text };
  }
}

class FakeRuntimeClient {
  constructor() {
    this.closed = 0;
    this.messages = [];
  }
  async ensureSession({ agentId, sessionName }) {
    return { backend: 'acpx', runtimeSessionName: sessionName ?? agentId, sessionKey: `${agentId}:${sessionName}` };
  }
  async runTurn({ runtimeHandle, messageText }) {
    this.messages.push(messageText);
    return { text: 'ok', runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  }
  async close() {
    this.closed += 1;
    return { ok: true };
  }
}

function configFor(dir) {
  return {
    runtime: { dataDir: dir },
    telegram: { polling: { enabled: false }, network: {} },
    agents: {
      providers: { codex: { driver: 'acpx', agent: 'codex' } },
      instances: { codex_cc: { providerId: 'codex', cwd: dir } }
    },
    bindings: { telegram: { dm: { '123': { instanceId: 'codex_cc' } }, group: {}, topic: {} } },
    session: {},
    logging: { dir }
  };
}

test('/new is forwarded to the agent and does not clear runtime binding state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-reset-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient();
  const app = await bootstrap({ config: configFor(dir), telegramApi, runtimeClient });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 1,
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      text: 'hello before reset',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' }
    }
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 2,
    message: {
      message_id: 3,
      date: Math.floor(Date.now() / 1000),
      text: '/new',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' }
    }
  });

  const sessionFile = path.join(dir, 'bindings', 'telegram', 'dm', '123.json');
  const session = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
  assert.equal(session.state, 'active');
  assert.equal(runtimeClient.closed, 0);
  assert.deepEqual(runtimeClient.messages, ['hello before reset', '/new']);
  assert.equal(telegramApi.sent.at(-1).text, 'ok');

  const conversationLogFile = path.join(dir, 'conversations', 'telegram', 'dm', '123.jsonl');
  const entries = (await fs.readFile(conversationLogFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    entries.map((entry) => ({ role: entry.role, text: entry.text })),
    [
      { role: 'user', text: 'hello before reset' },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: '/new' },
      { role: 'assistant', text: 'ok' }
    ]
  );
});
