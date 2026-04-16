import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { bootstrap } from '../../src/app/bootstrap.js';
import { runTriggerCommand } from '../../src/app/trigger-command.js';

class FakeTelegramApi {
  constructor() {
    this.sent = [];
  }

  async getMe() {
    return { id: 8641929320, username: 'crewline_bot', first_name: 'Crewline' };
  }

  async sendMessage(payload) {
    this.sent.push(payload);
    return { message_id: this.sent.length };
  }
}

class FakeRuntimeClient {
  constructor({ text = '已处理触发' } = {}) {
    this.text = text;
    this.calls = [];
  }

  async ensureSession({ agentId, sessionName }) {
    return { backend: 'acpx', runtimeSessionName: sessionName ?? agentId, sessionKey: `${agentId}:${sessionName}` };
  }

  async runTurn({ runtimeHandle, messageText }) {
    this.calls.push(messageText);
    return { text: this.text, runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  }

  async close() {
    return { ok: true };
  }
}

function telegramTriggerConfig(dir) {
  return {
    runtime: { dataDir: dir },
    channel: {
      telegram: {
        groupAllowFrom: [],
        requireMention: {
          group: true,
          topic: true
        },
        accounts: {
          '8641929320': {
            botToken: '8641929320:abc',
            bindings: {
              dm: {},
              group: {
                '-100123': { instanceId: 'codex_cc' }
              },
              topic: {}
            }
          }
        }
      }
    },
    agents: {
      providers: { codex: { driver: 'acpx', agent: 'codex' } },
      instances: { codex_cc: { providerId: 'codex', cwd: dir } }
    },
    bindings: {
      telegram: {
        dm: {},
        group: {},
        topic: {},
        accounts: {
          '8641929320': {
            dm: {},
            group: {
              '-100123': { instanceId: 'codex_cc' }
            },
            topic: {}
          }
        }
      },
      feishu: { dm: {}, group: {}, accounts: {} },
      wechat: { dm: {}, accounts: {} }
    },
    session: {},
    logging: { dir }
  };
}

test('runTriggerCommand posts visible trigger notice then routes synthetic telegram group turn', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-trigger-telegram-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient({ text: 'Agent 已收到处理' });

  const result = await runTriggerCommand({
    channel: 'telegram',
    argv: ['--account', '8641929320', '--chat-id', '-100123', '--text', '构建失败，请检查'],
    loadRuntimeConfig: async () => ({ config: telegramTriggerConfig(dir) }),
    createApp: async ({ config }) => bootstrap({
      config,
      telegramApi: { '8641929320': telegramApi },
      runtimeClient
    })
  });

  assert.equal(result.ok, true);
  assert.equal(runtimeClient.calls.length, 1);
  assert.equal(runtimeClient.calls[0], '触发：构建失败，请检查');
  assert.equal(telegramApi.sent.length, 2);
  assert.equal(telegramApi.sent[0].text, '触发：构建失败，请检查');
  assert.equal(telegramApi.sent[1].text, 'Agent 已收到处理');
});
