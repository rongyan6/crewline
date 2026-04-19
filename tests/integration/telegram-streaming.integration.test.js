import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { bootstrap } from '../../src/app/bootstrap.js';

class FakeTelegramApi {
  constructor() {
    this.chatActions = [];
    this.sent = [];
    this.photos = [];
    this.documents = [];
    this.streams = [];
    this.edits = [];
    this.events = [];
    this.files = [];
  }
  async getMe() {
    return { username: 'crewline_bot' };
  }
  async sendChatAction(payload) {
    this.events.push('typing');
    this.chatActions.push(payload);
    return { ok: true };
  }
  async sendMessage(payload) {
    this.sent.push(payload);
    return { message_id: this.sent.length };
  }
  async sendPhoto(payload) {
    this.photos.push(payload);
    return { message_id: this.sent.length + this.photos.length + this.documents.length };
  }
  async sendDocument(payload) {
    this.documents.push(payload);
    return { message_id: this.sent.length + this.photos.length + this.documents.length };
  }
  async editMessageText(payload) {
    this.edits.push(payload);
    this.streams.push(payload);
    return { message_id: payload.messageId ?? 1 };
  }
  async streamText({ chatId, chunks, initialText }) {
    let combined = '';
    for await (const chunk of chunks) combined += chunk;
    this.streams.push({ chatId, text: combined, initialText });
    return { messageId: 999, text: combined };
  }
  async getFile(fileId) {
    this.files.push({ type: 'getFile', fileId });
    return { file_path: `telegram/${fileId}.bin` };
  }
  async downloadFile(filePath) {
    this.files.push({ type: 'downloadFile', filePath });
    return Buffer.from(`bytes:${filePath}`);
  }
}

class FakeRuntimeClient {
  constructor({ text = 'hello world', chunks = ['hello ', 'world'], events = [] } = {}) {
    this.text = text;
    this.chunks = chunks;
    this.events = events;
  }
  async ensureSession({ agentId, sessionName }) {
    return { backend: 'acpx', runtimeSessionName: sessionName ?? agentId, sessionKey: `${agentId}:${sessionName}` };
  }
  async runTurn({ runtimeHandle, onChunk }) {
    this.events.push('runTurn');
    for (const chunk of this.chunks) onChunk?.(chunk);
    return { text: this.text, runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  }
  async close() { return { ok: true }; }
}

function configFor(dir) {
  return {
    runtime: { dataDir: dir },
    telegram: { polling: { enabled: false }, network: {}, groupAllowFrom: ['321'] },
    agents: {
      providers: { codex: { driver: 'acpx', agent: 'codex' } },
      instances: { codex_cc: { providerId: 'codex', cwd: dir } }
    },
    bindings: { telegram: { dm: { '123': { instanceId: 'codex_cc' } }, group: {}, topic: {} } },
    session: {},
    logging: { dir }
  };
}

test('bootstrap inbound handler emits typing and streaming output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-stream-'));
  const telegramApi = new FakeTelegramApi();
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      runtime: { ...configFor(dir).runtime, telegramTypingStartDelayMs: 0, telegramTypingIntervalMs: 50 }
    },
    telegramApi,
    runtimeClient: new FakeRuntimeClient()
  });
  await app.channelHost.setInboundHandler;
  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 1,
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      text: 'stream please',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' }
    }
  });
  assert.equal(telegramApi.chatActions.length > 0, true);
  assert.equal(telegramApi.sent.length > 0, true);
  assert.equal(telegramApi.sent.at(-1).text, 'hello world');
});

test('bootstrap sends final complete telegram reply even when runtime emits chunks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-stream-finalize-'));
  const finalText = '当前会话的主模型是 `gpt-5.4`。\n\n如果你问的是更细一点的运行档位：\n- 主代理：`gpt-5.4`\n- 当前我是主会话，不是子 agent';
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient({
    text: finalText,
    chunks: [
      '当前会话的主模型是 `gpt-5.4`。\n\n如果你问的是更细一点的运行档位：\n',
      '- 主代理：`gpt-5.4`\n- 当前我是主会话，不是子 agent'
    ]
  });
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      runtime: { ...configFor(dir).runtime, telegramTypingStartDelayMs: 0, telegramTypingIntervalMs: 50 }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 2,
    message: {
      message_id: 3,
      date: Math.floor(Date.now() / 1000),
      text: '当前模型是什么',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' }
    }
  });

  assert.equal(telegramApi.sent.length > 0, true);
  assert.equal(telegramApi.sent.at(-1).text, finalText);
  assert.equal(telegramApi.edits.length, 0);
});

test('bootstrap converts runtime local_path directives into outbound telegram attachments', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-outbound-attachment-'));
  const imagePath = path.join(dir, 'result.png');
  await fs.writeFile(imagePath, 'image-bytes', 'utf8');
  const telegramApi = new FakeTelegramApi();
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      runtime: { ...configFor(dir).runtime, telegramTypingStartDelayMs: 0, telegramTypingIntervalMs: 50 }
    },
    telegramApi,
    runtimeClient: new FakeRuntimeClient({
      text: `图已生成\nlocal_path: ${imagePath}`
    })
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 200,
    message: {
      message_id: 201,
      date: Math.floor(Date.now() / 1000),
      text: '发图给我',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' }
    }
  });

  assert.equal(telegramApi.sent.at(-1).text, '图已生成');
  assert.equal(telegramApi.photos.length, 1);
  assert.equal(telegramApi.photos[0].filePath, imagePath);
});

test('bootstrap fires initial typing concurrently with turn', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-typing-order-'));
  const events = [];
  class DelayedTypingTelegramApi extends FakeTelegramApi {
    async sendChatAction(payload) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('typing');
      this.chatActions.push(payload);
      return { ok: true };
    }
  }
  const telegramApi = new DelayedTypingTelegramApi();
  const runtimeClient = new FakeRuntimeClient({ events });
  runtimeClient.runTurn = async ({ runtimeHandle, onChunk }) => {
    events.push('runTurn');
    await new Promise((resolve) => setTimeout(resolve, 40));
    for (const chunk of runtimeClient.chunks) onChunk?.(chunk);
    return { text: runtimeClient.text, runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  };
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      runtime: { ...configFor(dir).runtime, telegramTypingStartDelayMs: 0, telegramTypingIntervalMs: 50 }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 3,
    message: {
      message_id: 4,
      date: Math.floor(Date.now() / 1000),
      text: 'typing first',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.includes('typing'), true);
  assert.equal(events.includes('runTurn'), true);
  assert.equal(telegramApi.chatActions.length > 0, true);
});

test('bootstrap skips typing request for fast turns when delayed typing is enabled', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-typing-delay-'));
  const telegramApi = new FakeTelegramApi();
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      runtime: { ...configFor(dir).runtime, telegramTypingStartDelayMs: 30, telegramTypingIntervalMs: 60 }
    },
    telegramApi,
    runtimeClient: new FakeRuntimeClient()
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 4,
    message: {
      message_id: 5,
      date: Math.floor(Date.now() / 1000),
      text: 'fast turn',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' }
    }
  });

  assert.equal(telegramApi.chatActions.length, 0);
});

test('bootstrap keeps handling telegram turns when the initial typing action fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-typing-failure-'));
  class FailingTypingTelegramApi extends FakeTelegramApi {
    async sendChatAction() {
      throw new Error('Client network socket disconnected before secure TLS connection was established');
    }
  }
  const telegramApi = new FailingTypingTelegramApi();
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      runtime: { ...configFor(dir).runtime, telegramTypingStartDelayMs: 0, telegramTypingIntervalMs: 50 }
    },
    telegramApi,
    runtimeClient: new FakeRuntimeClient({ text: 'still delivered' })
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 5,
    message: {
      message_id: 6,
      date: Math.floor(Date.now() / 1000),
      text: 'typing may fail',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(telegramApi.sent.at(-1).text, 'still delivered');
});

test('bootstrap ignores unmentioned telegram group message when requireMention.group is true', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-group-gate-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient();
  let runTurnCalled = false;
  runtimeClient.runTurn = async () => {
    runTurnCalled = true;
    throw new Error('should not run');
  };
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          requireMention: { group: true, topic: true }
        }
      },
      runtime: { ...configFor(dir).runtime, telegramTypingStartDelayMs: 0, telegramTypingIntervalMs: 50 },
      bindings: {
        telegram: {
          dm: {},
          group: { '-100123': { instanceId: 'codex_cc' } },
          topic: {}
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 50,
    message: {
      message_id: 51,
      date: Math.floor(Date.now() / 1000),
      text: 'hello group',
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 321, first_name: 'Json' }
    }
  });

  assert.equal(runTurnCalled, false);
  assert.equal(telegramApi.sent.length, 0);
});

test('bootstrap ignores telegram group message from sender outside global groupAllowFrom', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-group-allowlist-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient();
  let runTurnCalled = false;
  runtimeClient.runTurn = async () => {
    runTurnCalled = true;
    throw new Error('should not run');
  };
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          requireMention: { group: false, topic: false }
        }
      },
      bindings: {
        telegram: {
          dm: {},
          group: { '-100123': { instanceId: 'codex_cc' } },
          topic: {}
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 52,
    message: {
      message_id: 53,
      date: Math.floor(Date.now() / 1000),
      text: 'hello blocked group',
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 999, first_name: 'Blocked' }
    }
  });

  assert.equal(runTurnCalled, false);
  assert.equal(telegramApi.sent.length, 0);
});

test('bootstrap handles mentioned telegram group message when requireMention.group is true', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-group-mention-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient({ text: 'group reply' });
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          requireMention: { group: true, topic: true }
        }
      },
      bindings: {
        telegram: {
          dm: {},
          group: { '-100123': { instanceId: 'codex_cc' } },
          topic: {}
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 52,
    message: {
      message_id: 53,
      date: Math.floor(Date.now() / 1000),
      text: '@crewline_bot hello group',
      entities: [{ type: 'mention', offset: 0, length: 13 }],
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 321, first_name: 'Json' }
    }
  });

  assert.equal(telegramApi.sent.at(-1).text, 'group reply');
});

test('bootstrap allows a configured group to bypass global requireMention', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-group-override-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient({ text: 'group override reply' });
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          requireMention: { group: true, topic: true },
          groups: {
            '-100123': { requireMention: false }
          }
        }
      },
      bindings: {
        telegram: {
          dm: {},
          group: { '-100123': { instanceId: 'codex_cc' } },
          topic: {}
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 54,
    message: {
      message_id: 55,
      date: Math.floor(Date.now() / 1000),
      text: 'hello override group',
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 321, first_name: 'Json' }
    }
  });

  assert.equal(telegramApi.sent.at(-1).text, 'group override reply');
});

test('bootstrap allows telegram group message from sender allowed by group override', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-group-allow-override-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient({ text: 'group allow override reply' });
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          requireMention: { group: false, topic: false },
          groups: {
            '-100123': { groupAllowFrom: ['999'] }
          }
        }
      },
      bindings: {
        telegram: {
          dm: {},
          group: { '-100123': { instanceId: 'codex_cc' } },
          topic: {}
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 54,
    message: {
      message_id: 55,
      date: Math.floor(Date.now() / 1000),
      text: 'hello allowed override',
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 999, first_name: 'Allowed' }
    }
  });

  assert.equal(telegramApi.sent.at(-1).text, 'group allow override reply');
});

test('bootstrap ignores unmentioned telegram topic message when requireMention.topic is true', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-topic-gate-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient();
  let runTurnCalled = false;
  runtimeClient.runTurn = async () => {
    runTurnCalled = true;
    throw new Error('should not run');
  };
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          requireMention: { group: false, topic: true }
        }
      },
      bindings: {
        telegram: {
          dm: {},
          group: {},
          topic: { '-100123:42': { instanceId: 'codex_cc' } }
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 54,
    message: {
      message_id: 55,
      date: Math.floor(Date.now() / 1000),
      text: 'hello topic',
      chat: { id: -100123, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 42,
      from: { id: 321, first_name: 'Json' }
    }
  });

  assert.equal(runTurnCalled, false);
});

test('bootstrap ignores telegram topic message from sender outside global groupAllowFrom', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-topic-allowlist-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient();
  let runTurnCalled = false;
  runtimeClient.runTurn = async () => {
    runTurnCalled = true;
    throw new Error('should not run');
  };
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          requireMention: { group: false, topic: false }
        }
      },
      bindings: {
        telegram: {
          dm: {},
          group: {},
          topic: { '-100123:42': { instanceId: 'codex_cc' } }
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 56,
    message: {
      message_id: 57,
      date: Math.floor(Date.now() / 1000),
      text: 'hello blocked topic',
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 999, first_name: 'Blocked' },
      is_topic_message: true,
      message_thread_id: 42
    }
  });

  assert.equal(runTurnCalled, false);
  assert.equal(telegramApi.sent.length, 0);
});

test('bootstrap uses telegram streamText when telegram.streaming is true', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-streaming-enabled-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient({ text: 'hello world', chunks: ['hello ', 'world'] });
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          streaming: true
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 56,
    message: {
      message_id: 57,
      date: Math.floor(Date.now() / 1000),
      text: 'stream to telegram',
      chat: { id: 123, type: 'private' },
      from: { id: 123, first_name: 'Json' }
    }
  });

  assert.equal(telegramApi.streams.length > 0, true);
});

test('bootstrap starts telegram stream before runtime finishes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-live-streaming-'));
  const telegramApi = new FakeTelegramApi();
  let streamStartedAt = null;
  let runtimeFinishedAt = null;

  telegramApi.streamText = async ({ chunks, chatId, initialText }) => {
    streamStartedAt = Date.now();
    let combined = '';
    for await (const chunk of chunks) combined += chunk;
    telegramApi.streams.push({ chatId, text: combined, initialText });
    return { messageId: 999, text: combined };
  };

  const runtimeClient = new FakeRuntimeClient({
    text: 'hello world',
    chunks: ['hello ', 'world']
  });
  runtimeClient.runTurn = async ({ runtimeHandle, onChunk }) => {
    onChunk?.('hello ');
    await new Promise((resolve) => setTimeout(resolve, 30));
    onChunk?.('world');
    await new Promise((resolve) => setTimeout(resolve, 30));
    runtimeFinishedAt = Date.now();
    return { text: 'hello world', runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  };

  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          streaming: true
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 58,
    message: {
      message_id: 59,
      date: Math.floor(Date.now() / 1000),
      text: 'live stream to telegram',
      chat: { id: 123, type: 'private' },
      from: { id: 123, first_name: 'Json' }
    }
  });

  assert.equal(typeof streamStartedAt, 'number');
  assert.equal(typeof runtimeFinishedAt, 'number');
  assert.equal(streamStartedAt < runtimeFinishedAt, true);
});

test('bootstrap falls back to final telegram send when live stream send rejects early', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-stream-fallback-'));
  const telegramApi = new FakeTelegramApi();
  telegramApi.streamText = async () => {
    throw new Error('Client network socket disconnected before secure TLS connection was established');
  };
  const runtimeClient = new FakeRuntimeClient({
    text: 'final fallback text',
    chunks: ['final ', 'fallback ', 'text']
  });
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      channel: {
        telegram: {
          ...(configFor(dir).telegram ?? {}),
          streaming: true
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 60,
    message: {
      message_id: 61,
      date: Math.floor(Date.now() / 1000),
      text: 'stream may fail',
      chat: { id: 123, type: 'private' },
      from: { id: 123, first_name: 'Json' }
    }
  });

  assert.equal(telegramApi.sent.at(-1).text, 'final fallback text');
});

test('bootstrap converts inbound photo into downloaded local-path prompt text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-photo-'));
  let observedMessageText = null;
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient();
  runtimeClient.runTurn = async ({ runtimeHandle, messageText }) => {
    observedMessageText = messageText;
    return { text: '已收到图片', runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  };
  const app = await bootstrap({ config: configFor(dir), telegramApi, runtimeClient });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 5,
    message: {
      message_id: 6,
      date: Math.floor(Date.now() / 1000),
      caption: '请看图片',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' },
      photo: [
        { file_id: 'small-photo', width: 64, height: 64, file_size: 1000 },
        { file_id: 'large-photo', width: 1024, height: 1024, file_size: 4000 }
      ]
    }
  });

  assert.match(observedMessageText, /图片附件/);
  assert.match(observedMessageText, /caption: 请看图片/);
  assert.match(observedMessageText, /local_path:/);
  assert.equal(telegramApi.files.some((entry) => entry.fileId === 'large-photo'), true);
});

test('bootstrap sends topic replies back into the same telegram topic', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-topic-send-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient({ text: 'topic reply' });
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      bindings: {
        telegram: {
          dm: {},
          group: {},
          topic: { '-100123:42': { instanceId: 'codex_cc' } }
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 70,
    message: {
      message_id: 71,
      date: Math.floor(Date.now() / 1000),
      text: 'hello topic send',
      chat: { id: -100123, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 42,
      from: { id: 321, first_name: 'Json' }
    }
  });

  assert.equal(telegramApi.sent.at(-1).messageThreadId, 42);
});

test('bootstrap includes General topic thread id in typing for telegram forum group messages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-general-typing-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient({ text: 'group reply', chunks: ['group ', 'reply'] });
  const app = await bootstrap({
    config: {
      ...configFor(dir),
      runtime: { ...configFor(dir).runtime, telegramTypingStartDelayMs: 0, telegramTypingIntervalMs: 50 },
      bindings: {
        telegram: {
          dm: {},
          group: { '-100123': { instanceId: 'codex_cc' } },
          topic: {}
        }
      }
    },
    telegramApi,
    runtimeClient
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 71,
    message: {
      message_id: 72,
      date: Math.floor(Date.now() / 1000),
      text: 'hello general',
      chat: { id: -100123, type: 'supergroup', is_forum: true },
      from: { id: 321, first_name: 'Json' }
    }
  });

  assert.equal(telegramApi.chatActions.length > 0, true);
  assert.equal(telegramApi.chatActions.at(0).messageThreadId, 1);
  assert.equal(telegramApi.sent.at(-1).messageThreadId, undefined);
});

test('bootstrap replies locally for unsupported telegram message types', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-unsupported-'));
  const telegramApi = new FakeTelegramApi();
  const runtimeClient = new FakeRuntimeClient();
  let runTurnCalled = false;
  runtimeClient.runTurn = async () => {
    runTurnCalled = true;
    throw new Error('should not run');
  };
  const app = await bootstrap({ config: configFor(dir), telegramApi, runtimeClient });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 6,
    message: {
      message_id: 7,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' },
      sticker: { file_id: 'sticker-1' }
    }
  });

  assert.equal(runTurnCalled, false);
  assert.match(telegramApi.sent.at(-1).text, /暂不支持的消息类型：sticker/);
});

test('bootstrap replies locally when attachment download fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-download-fail-'));
  const telegramApi = new FakeTelegramApi();
  telegramApi.downloadFile = async () => {
    throw new Error('tls handshake failed');
  };
  const runtimeClient = new FakeRuntimeClient();
  let runTurnCalled = false;
  runtimeClient.runTurn = async () => {
    runTurnCalled = true;
    throw new Error('should not run');
  };
  const app = await bootstrap({ config: configFor(dir), telegramApi, runtimeClient });

  await app.channelHost.dispatchRawEvent('telegram', {
    update_id: 7,
    message: {
      message_id: 8,
      date: Math.floor(Date.now() / 1000),
      caption: '下载失败图片',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' },
      photo: [
        { file_id: 'photo-large', width: 1024, height: 1024, file_size: 4000 }
      ]
    }
  });

  assert.equal(runTurnCalled, false);
  assert.match(telegramApi.sent.at(-1).text, /附件下载失败/);
  assert.match(telegramApi.sent.at(-1).text, /proxy_configured: no/);
});

test('bootstrap routes telegram messages by bot account and isolates state paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-telegram-accounts-'));
  const mainApi = new FakeTelegramApi();
  const reviewApi = new FakeTelegramApi();
  const app = await bootstrap({
    config: {
      runtime: { dataDir: dir, telegramTypingStartDelayMs: 0, telegramTypingIntervalMs: 50 },
      channel: {
        telegram: {
          groupAllowFrom: ['123', '456'],
          streaming: true,
          accounts: {
            '8641929320': {
              botToken: '8641929320:main-secret',
              streaming: true,
              bindings: { dm: { '123': { instanceId: 'codex_cc' } }, group: {}, topic: {} }
            },
            '8641929321': {
              botToken: '8641929321:review-secret',
              streaming: false,
              bindings: { dm: { '456': { instanceId: 'claude_cc' } }, group: {}, topic: {} }
            }
          }
        }
      },
      agents: {
        providers: {
          codex: { driver: 'acpx', agent: 'codex' },
          claude: { driver: 'acpx', agent: 'claude' }
        },
        instances: {
          codex_cc: { providerId: 'codex', cwd: dir },
          claude_cc: { providerId: 'claude', cwd: dir }
        }
      },
      bindings: {
        telegram: {
          dm: {},
          group: {},
          topic: {},
          accounts: {
            '8641929320': { dm: { '123': { instanceId: 'codex_cc' } }, group: {}, topic: {} },
            '8641929321': { dm: { '456': { instanceId: 'claude_cc' } }, group: {}, topic: {} }
          }
        }
      },
      session: {},
      logging: { dir },
      secrets: {
        telegramAccounts: {
          '8641929320': { botToken: '8641929320:main-secret' },
          '8641929321': { botToken: '8641929321:review-secret' }
        }
      }
    },
    telegramApi: {
      '8641929320': mainApi,
      '8641929321': reviewApi
    },
    runtimeClient: new FakeRuntimeClient({ text: 'done', chunks: ['do', 'ne'] })
  });

  await app.channelHost.dispatchRawEvent('telegram', {
    accountId: '8641929320',
    update_id: 8,
    message: {
      message_id: 9,
      date: Math.floor(Date.now() / 1000),
      text: 'main bot',
      chat: { id: 123 },
      from: { id: 123, first_name: 'Json' }
    }
  });
  await app.channelHost.dispatchRawEvent('telegram', {
    accountId: '8641929321',
    update_id: 10,
    message: {
      message_id: 11,
      date: Math.floor(Date.now() / 1000),
      text: 'review bot',
      chat: { id: 456 },
      from: { id: 456, first_name: 'Json' }
    }
  });

  assert.equal(mainApi.streams.at(-1).text, 'done');
  assert.equal(reviewApi.sent.at(-1).text, 'done');

  const mainBindingPath = path.join(dir, 'bindings', 'telegram', '8641929320', 'dm', '123.json');
  const reviewBindingPath = path.join(dir, 'bindings', 'telegram', '8641929321', 'dm', '456.json');
  await fs.access(mainBindingPath);
  await fs.access(reviewBindingPath);

  const mainLogPath = path.join(dir, 'conversations', 'telegram', '8641929320', 'dm', '123.jsonl');
  const reviewLogPath = path.join(dir, 'conversations', 'telegram', '8641929321', 'dm', '456.jsonl');
  await fs.access(mainLogPath);
  await fs.access(reviewLogPath);
});
