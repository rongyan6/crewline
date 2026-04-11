import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { bootstrap } from '../../src/app/bootstrap.js';

class FakeRuntimeClient {
  constructor({ text = 'wechat runtime ok' } = {}) {
    this.text = text;
    this.calls = [];
    this.ensureCalls = [];
  }
  async ensureSession({ agentId, sessionName }) {
    this.ensureCalls.push({ agentId, sessionName });
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

function wechatConfigFor(dir) {
  return {
    runtime: { dataDir: dir },
    channel: {
      wechat: {
        enabled: true,
        accounts: {
          'bot@im.bot': {
            bindings: {
              dm: {
                wxid_alice: { instanceId: 'codex_cc' }
              }
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
      telegram: { dm: {}, group: {}, topic: {} },
      feishu: { dm: {}, group: {}, accounts: {} },
      wechat: {
        dm: {},
        accounts: {
          'bot@im.bot': {
            dm: {
              wxid_alice: { instanceId: 'codex_cc' }
            }
          }
        }
      }
    },
    session: {},
    logging: { dir }
  };
}

test('bootstrap uses first-session greeting for wechat hello and routes later hello to runtime', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-greeting-'));
  const runtimeClient = new FakeRuntimeClient({ text: 'wechat runtime ok' });
  const app = await bootstrap({
    config: wechatConfigFor(dir),
    runtimeClient
  });

  const sent = [];
  app.wechatPlugin.bridge.resolveConfig = () => ({});
  app.wechatPlugin.bridge.normalizeInbound = ({ accountId }) => ({
    accountId,
    conversationRef: {
      channel: 'wechat',
      accountId,
      conversationId: 'wxid_alice',
      participantId: 'wxid_alice',
      scope: 'dm'
    },
    senderRef: { userId: 'wxid_alice' },
    messageId: `m-${Date.now()}`,
    timestamp: new Date().toISOString(),
    rawMeta: {}
  });
  app.wechatPlugin.bridge.send = async ({ outboundMessage }) => {
    sent.push(outboundMessage);
    return { ok: true, messageId: `m${sent.length}` };
  };
  app.wechatPlugin.createTypingSession = async () => null;

  await app.channelHost.dispatchRawEvent('wechat', {
    accountId: 'bot@im.bot',
    message: {
      create_time_ms: Date.now(),
      item_list: [{ type: 1, text_item: { text: 'hi' } }]
    }
  });

  assert.match(sent[0].text, /新会话已启动/);
  assert.match(sent[0].text, /当前 Agent：Codex \(codex_cc\)/);
  assert.match(sent[0].text, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(runtimeClient.calls.length, 0);
  assert.equal(runtimeClient.ensureCalls.length, 1);

  await app.channelHost.dispatchRawEvent('wechat', {
    accountId: 'bot@im.bot',
    message: {
      create_time_ms: Date.now(),
      item_list: [{ type: 1, text_item: { text: 'hi' } }]
    }
  });

  assert.equal(runtimeClient.calls.length, 1);
  assert.equal(runtimeClient.calls[0], 'hi');
  assert.equal(sent[1].text, 'wechat runtime ok');
});
