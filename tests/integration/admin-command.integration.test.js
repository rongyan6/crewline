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

  async getMe() {
    return { id: 8641929320, username: 'crewline_bot', first_name: 'Crewline' };
  }

  async sendMessage(payload) {
    this.sent.push(payload);
    return { ok: true, messageId: `m${this.sent.length}` };
  }
}

function wechatConfigFor(dir) {
  return {
    runtime: { dataDir: dir },
    channel: {
      wechat: {
        enabled: true,
        adminUserIds: ['wxid_admin'],
        accounts: {
          'bot@im.bot': {
            bindings: {
              dm: {
                wxid_admin: { instanceId: 'codex_cc' }
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
      telegram: { dm: {}, group: {}, topic: {}, accounts: {} },
      feishu: { dm: {}, group: {}, accounts: {} },
      wechat: {
        dm: {},
        accounts: {
          'bot@im.bot': {
            dm: {
              wxid_admin: { instanceId: 'codex_cc' }
            }
          }
        }
      }
    },
    session: {},
    logging: { dir }
  };
}

function telegramConfigFor(dir) {
  return {
    runtime: { dataDir: dir },
    channel: {
      telegram: {
        adminUserIds: ['123'],
        accounts: {
          '8641929320': {
            botToken: '8641929320:abc',
            bindings: { dm: {}, group: {}, topic: {} }
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
          '8641929320': { dm: {}, group: {}, topic: {} }
        }
      },
      feishu: { dm: {}, group: {}, accounts: {} },
      wechat: { dm: {}, accounts: {} }
    },
    session: {},
    logging: { dir }
  };
}

test('bootstrap intercepts /admin_help before runtime routing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-admin-help-'));
  const api = new FakeTelegramApi();
  const app = await bootstrap({
    config: telegramConfigFor(dir),
    telegramApi: {
      '8641929320': api
    },
    runtimeClient: {
      async ensureSession() {
        throw new Error('runtime should not be called');
      }
    }
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    accountId: '8641929320',
    update: {
      update_id: 1,
      message: {
        message_id: 11,
        date: Math.floor(Date.now() / 1000),
        text: '/admin_help',
        chat: { id: 123, type: 'private' },
        from: { id: 123, first_name: 'Admin' }
      }
    }
  });

  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0].text, /管理命令/);
  assert.doesNotMatch(api.sent[0].text, /\/admin_add/);
});

test('bootstrap suppresses duplicate admin command deliveries for the same message id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-admin-dedup-'));
  const api = new FakeTelegramApi();
  const app = await bootstrap({
    config: telegramConfigFor(dir),
    telegramApi: {
      '8641929320': api
    },
    runtimeClient: {
      async ensureSession() {
        throw new Error('runtime should not be called');
      }
    }
  });

  const rawEvent = {
    accountId: '8641929320',
    update: {
      update_id: 99,
      message: {
        message_id: 199,
        date: Math.floor(Date.now() / 1000),
        text: '/admin_help',
        chat: { id: 123, type: 'private' },
        from: { id: 123, first_name: 'Admin' }
      }
    }
  };

  await app.channelHost.dispatchRawEvent('telegram', rawEvent);
  await app.channelHost.dispatchRawEvent('telegram', rawEvent);

  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0].text, /管理命令/);
});

test('bootstrap rejects admin commands from telegram groups', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-admin-group-'));
  const api = new FakeTelegramApi();
  const app = await bootstrap({
    config: telegramConfigFor(dir),
    telegramApi: {
      '8641929320': api
    },
    runtimeClient: {
      async ensureSession() {
        throw new Error('runtime should not be called');
      }
    }
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    accountId: '8641929320',
    update: {
      update_id: 2,
      message: {
        message_id: 12,
        date: Math.floor(Date.now() / 1000),
        text: '/admin_help',
        chat: { id: -100123, type: 'group' },
        from: { id: 123, first_name: 'Admin' }
      }
    }
  });

  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0].text, /仅支持在私聊中使用/);
  assert.equal(api.sent[0].replyTo, '12');
});

test('bootstrap replies to telegram topic admin commands inside the same topic thread', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-admin-topic-'));
  const api = new FakeTelegramApi();
  const app = await bootstrap({
    config: telegramConfigFor(dir),
    telegramApi: {
      '8641929320': api
    },
    runtimeClient: {
      async ensureSession() {
        throw new Error('runtime should not be called');
      }
    }
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    accountId: '8641929320',
    update: {
      update_id: 3,
      message: {
        message_id: 42,
        date: Math.floor(Date.now() / 1000),
        text: '/admin_help',
        is_topic_message: true,
        message_thread_id: 777,
        chat: { id: -100123, type: 'supergroup', is_forum: true },
        from: { id: 123, first_name: 'Admin' }
      }
    }
  });

  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0].text, /仅支持在私聊中使用/);
  assert.equal(api.sent[0].replyTo, '42');
  assert.equal(api.sent[0].messageThreadId, 777);
});

test('bootstrap replies to telegram forum General admin commands without forcing thread id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-admin-general-'));
  const api = new FakeTelegramApi();
  const app = await bootstrap({
    config: telegramConfigFor(dir),
    telegramApi: {
      '8641929320': api
    },
    runtimeClient: {
      async ensureSession() {
        throw new Error('runtime should not be called');
      }
    }
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    accountId: '8641929320',
    update: {
      update_id: 4,
      message: {
        message_id: 43,
        date: Math.floor(Date.now() / 1000),
        text: '/admin_help',
        chat: { id: -100123, type: 'supergroup', is_forum: true },
        from: { id: 123, first_name: 'Admin' }
      }
    }
  });

  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0].text, /仅支持在私聊中使用/);
  assert.equal(api.sent[0].replyTo, '43');
  assert.equal(api.sent[0].messageThreadId, undefined);
});

test('bootstrap handles wechat admin help in dm', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-admin-help-'));
  const app = await bootstrap({
    config: wechatConfigFor(dir),
    runtimeClient: {
      async ensureSession() {
        throw new Error('runtime should not be called');
      }
    }
  });

  const sent = [];
  app.wechatPlugin.bridge.resolveConfig = () => ({});
  app.wechatPlugin.bridge.normalizeInbound = ({ accountId }) => ({
    accountId,
    conversationRef: {
      channel: 'wechat',
      accountId,
      conversationId: 'wxid_admin',
      participantId: 'wxid_admin',
      scope: 'dm'
    },
    senderRef: { userId: 'wxid_admin' },
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
      item_list: [{ type: 1, text_item: { text: '/admin_help' } }]
    }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /管理命令/);
  assert.doesNotMatch(sent[0].text, /\/admin_add/);
});
