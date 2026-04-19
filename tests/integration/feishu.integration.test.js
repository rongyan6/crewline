import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { bootstrap } from '../../src/app/bootstrap.js';

class FakeRuntimeClient {
  constructor({ text = 'feishu ok' } = {}) {
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

function feishuConfigFor(dir) {
  return {
    runtime: { dataDir: dir },
    channel: {
      feishu: {
        enabled: true,
        groupAllowFrom: ['ou_123'],
        accounts: {
          appid: {
            appSecret: 'secret',
            bindings: {
              dm: { ou_123: { instanceId: 'codex_cc' } },
              group: {}
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
      feishu: { dm: {}, group: {}, accounts: { appid: { dm: { ou_123: { instanceId: 'codex_cc' } }, group: {} } } }
    },
    session: {},
    logging: { dir },
    secrets: {
      feishuAccounts: {
        appid: { appId: 'appid', appSecret: 'secret' }
      }
    }
  };
}

function createFeishuSdkSpy() {
  const sent = [];
  const reactions = [];
  const imageUploads = [];
  const fileUploads = [];
  return {
    sent,
    reactions,
    imageUploads,
    fileUploads,
    createClient: () => ({
      request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
      im: {
        image: {
          create: async (payload) => {
            imageUploads.push(payload);
            return { data: { image_key: `img_${imageUploads.length}` } };
          }
        },
        file: {
          create: async (payload) => {
            fileUploads.push(payload);
            return { data: { file_key: `file_${fileUploads.length}` } };
          }
        },
        messageResource: {
          get: async () => Buffer.from('feishu-bytes')
        },
        messageReaction: {
          create: async (payload) => {
            reactions.push({ type: 'create', payload });
            return { data: { reaction_id: `reaction_${reactions.length}` } };
          },
          delete: async (payload) => {
            reactions.push({ type: 'delete', payload });
            return { data: {} };
          }
        },
        message: {
          create: async (payload) => {
            sent.push(payload);
            return { data: { message_id: `om_${sent.length}` } };
          },
          patch: async (payload) => {
            sent.push(payload);
            return { data: { message_id: `om_${sent.length}` } };
          },
          reply: async (payload) => {
            sent.push(payload);
            return { data: { message_id: `om_${sent.length}` } };
          }
        }
      }
    }),
    createEventDispatcher: () => ({ register() {} }),
    createWsClient: () => ({ start() {}, close() {} })
  };
}

function readFeishuContent(entry) {
  const content = JSON.parse(entry.data.content);
  if (typeof content.text === 'string') return content.text;
  return content?.body?.elements?.[0]?.content ?? '';
}

test('bootstrap handles inbound feishu text and sends outbound reply', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-'));
  const sdk = createFeishuSdkSpy();
  const runtimeClient = new FakeRuntimeClient({ text: '已收到飞书消息' });
  const app = await bootstrap({
    config: feishuConfigFor(dir),
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello feishu' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.equal(runtimeClient.calls[0], 'hello feishu');
  assert.equal(sdk.sent.length > 0, true);
  assert.equal(readFeishuContent(sdk.sent.at(-1)), '已收到飞书消息');
});

test('bootstrap converts runtime local_path directives into outbound feishu attachments', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-outbound-attachment-'));
  const imagePath = path.join(dir, 'chart.png');
  await fs.writeFile(imagePath, 'image-bytes', 'utf8');
  const sdk = createFeishuSdkSpy();
  const runtimeClient = new FakeRuntimeClient({ text: `图已生成\nlocal_path: ${imagePath}` });
  const app = await bootstrap({
    config: feishuConfigFor(dir),
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_attach_1',
      chat_id: 'oc_attach_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'send image' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.equal(readFeishuContent(sdk.sent[0]), '图已生成');
  assert.equal(sdk.imageUploads.length, 1);
  assert.equal(sdk.sent[1].data.msg_type, 'image');
  assert.equal(JSON.parse(sdk.sent[1].data.content).image_key, 'img_1');
});

test('bootstrap intercepts exact local file send requests before runtime execution', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-direct-send-'));
  const filePath = path.join(dir, 'README.md');
  await fs.writeFile(filePath, '# hi', 'utf8');
  const sdk = createFeishuSdkSpy();
  const runtimeClient = new FakeRuntimeClient({ text: 'should not run' });
  const app = await bootstrap({
    config: feishuConfigFor(dir),
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_direct_1',
      chat_id: 'oc_direct_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: `把文件${filePath}发给我` }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.equal(runtimeClient.calls.length, 0);
  assert.equal(sdk.fileUploads.length, 1);
  assert.equal(JSON.parse(sdk.sent[0].data.content).file_key, 'file_1');
});

test('bootstrap lets agent resolve fuzzy attachment requests through structured attachment action blocks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-agent-send-'));
  const filePath = path.join(dir, 'README.md');
  await fs.writeFile(filePath, '# hi', 'utf8');
  const sdk = createFeishuSdkSpy();
  let observedMessageText = '';
  const runtimeClient = new FakeRuntimeClient();
  runtimeClient.runTurn = async ({ runtimeHandle, messageText }) => {
    observedMessageText = messageText;
    return {
      text: [
        'README 发你了。',
        '```crewline-send-attachments',
        JSON.stringify({ attachments: [{ path: filePath }] }),
        '```'
      ].join('\n'),
      runtimeHandle,
      exitCode: 0,
      stderr: '',
      stopReason: 'end_turn'
    };
  };
  const app = await bootstrap({
    config: feishuConfigFor(dir),
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_agent_1',
      chat_id: 'oc_agent_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '把 README 发给我' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.match(observedMessageText, /crewline-send-attachments/);
  assert.match(observedMessageText, /不要粘贴文件内容/);
  assert.equal(sdk.fileUploads.length, 1);
  assert.equal(readFeishuContent(sdk.sent[0]), 'README 发你了。');
  assert.equal(JSON.parse(sdk.sent[1].data.content).file_key, 'file_1');
});

test('bootstrap sends local first-session greeting for simple feishu hello', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-greeting-'));
  const sdk = createFeishuSdkSpy();
  const runtimeClient = new FakeRuntimeClient({ text: 'should not run' });
  const app = await bootstrap({
    config: feishuConfigFor(dir),
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_hi_1',
      chat_id: 'oc_hi_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  const reply = readFeishuContent(sdk.sent.at(-1));
  assert.match(reply, /新会话已启动/);
  assert.match(reply, /当前 Agent：Codex \(codex_cc\)/);
  assert.match(reply, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(runtimeClient.calls.length, 0);
  assert.equal(runtimeClient.ensureCalls.length, 1);
  await fs.access(path.join(dir, 'bindings', 'feishu', 'appid', 'dm', 'oc_hi_1.json'));
});

test('bootstrap locally replies when feishu media download fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-unsupported-'));
  const sdk = createFeishuSdkSpy();
  sdk.createClient = () => ({
    request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
    im: {
      messageResource: {
        get: async () => {
          throw new Error('download failed');
        }
      },
      message: {
        create: async (payload) => {
          sdk.sent.push(payload);
          return { data: { message_id: `om_${sdk.sent.length}` } };
        },
        reply: async (payload) => {
          sdk.sent.push(payload);
          return { data: { message_id: `om_${sdk.sent.length}` } };
        }
      }
    }
  });
  const runtimeClient = new FakeRuntimeClient();
  const app = await bootstrap({
    config: feishuConfigFor(dir),
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_2',
      chat_id: 'oc_2',
      chat_type: 'p2p',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_1' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123' }
    }
  });

  assert.equal(runtimeClient.calls.length, 0);
  assert.match(JSON.parse(sdk.sent.at(-1).data.content).text, /Feishu 图片下载失败/);
});

test('bootstrap caches inbound feishu file and passes local path to runtime', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-file-'));
  const sdk = createFeishuSdkSpy();
  const runtimeClient = new FakeRuntimeClient({ text: '已收到飞书文件' });
  const app = await bootstrap({
    config: feishuConfigFor(dir),
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_file_1',
      chat_id: 'oc_file',
      chat_type: 'p2p',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_1', file_name: 'spec.md' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.match(runtimeClient.calls[0], /Feishu 文件附件/);
  assert.match(runtimeClient.calls[0], /local_path:/);
  await fs.access(path.join(dir, 'attachments', 'feishu'));
});

test('bootstrap uses feishu streaming card mode when enabled', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-stream-'));
  const sdk = createFeishuSdkSpy();
  const runtimeClient = new FakeRuntimeClient({ text: '最终结果' });
  runtimeClient.runTurn = async ({ runtimeHandle, onChunk, messageText }) => {
    runtimeClient.calls.push(messageText);
    onChunk?.('最');
    onChunk?.('终');
    onChunk?.('结');
    onChunk?.('果');
    return { text: '最终结果', runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  };
  const config = feishuConfigFor(dir);
  config.channel.feishu.streaming = true;
  config.channel.feishu.footer = { elapsed: true, status: true };

  const app = await bootstrap({
    config,
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_stream_1',
      chat_id: 'oc_stream',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'stream please' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.equal(sdk.sent.some((entry) => entry.data?.msg_type === 'interactive'), true);
});

test('bootstrap sends feishu generating card before runtime finishes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-stream-early-'));
  const sdk = createFeishuSdkSpy();
  let createAt = null;
  let runtimeFinishedAt = null;
  const originalCreateClient = sdk.createClient;
  sdk.createClient = (...args) => {
    const client = originalCreateClient(...args);
    const originalCreate = client.im.message.create;
    client.im.message.create = async (payload) => {
      createAt = Date.now();
      return originalCreate(payload);
    };
    return client;
  };

  const runtimeClient = new FakeRuntimeClient({ text: '最终结果' });
  runtimeClient.runTurn = async ({ runtimeHandle, onChunk, messageText }) => {
    runtimeClient.calls.push(messageText);
    await new Promise((resolve) => setTimeout(resolve, 30));
    onChunk?.('最');
    onChunk?.('终');
    onChunk?.('结');
    onChunk?.('果');
    await new Promise((resolve) => setTimeout(resolve, 30));
    runtimeFinishedAt = Date.now();
    return { text: '最终结果', runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  };
  const config = feishuConfigFor(dir);
  config.channel.feishu.streaming = true;
  config.channel.feishu.footer = { elapsed: true, status: true };

  const app = await bootstrap({
    config,
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_stream_early_1',
      chat_id: 'oc_stream_early',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'start stream early' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.equal(typeof createAt, 'number');
  assert.equal(typeof runtimeFinishedAt, 'number');
  assert.equal(createAt < runtimeFinishedAt, true);
});

test('bootstrap finalizes feishu pending reply when runtime fails after streaming starts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-stream-failure-'));
  const sdk = createFeishuSdkSpy();
  const operations = [];
  const originalCreateClient = sdk.createClient;
  sdk.createClient = (...args) => {
    const client = originalCreateClient(...args);
    for (const methodName of ['create', 'patch', 'reply']) {
      const originalMethod = client.im.message?.[methodName];
      if (!originalMethod) continue;
      client.im.message[methodName] = async (payload) => {
        operations.push(methodName);
        return originalMethod(payload);
      };
    }
    return client;
  };

  const runtimeClient = new FakeRuntimeClient();
  runtimeClient.runTurn = async ({ messageText, onChunk }) => {
    runtimeClient.calls.push(messageText);
    onChunk?.('半');
    onChunk?.('截');
    throw new Error('运行失败');
  };
  const config = feishuConfigFor(dir);
  config.channel.feishu.streaming = true;
  config.channel.feishu.footer = { status: true };

  const app = await bootstrap({
    config,
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_stream_fail_1',
      chat_id: 'oc_stream_fail',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'stream then fail' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.equal(operations[0], 'create');
  assert.equal(operations.at(-1), 'patch');
  assert.equal(operations.filter((entry) => entry === 'create').length, 1);
  assert.equal(operations.filter((entry) => entry === 'reply').length, 0);
  assert.equal(operations.filter((entry) => entry === 'patch').length >= 2, true);
  assert.match(readFeishuContent(sdk.sent.at(-1)), /运行失败/);
  assert.match(readFeishuContent(sdk.sent.at(-1)), /状态：执行失败/);
});

test('bootstrap adds and removes feishu typing reaction while runtime is running', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-typing-'));
  const sdk = createFeishuSdkSpy();
  const runtimeClient = new FakeRuntimeClient({ text: '普通最终结果' });
  runtimeClient.runTurn = async ({ runtimeHandle, messageText }) => {
    runtimeClient.calls.push(messageText);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { text: '普通最终结果', runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  };

  const app = await bootstrap({
    config: feishuConfigFor(dir),
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_typing_1',
      chat_id: 'oc_typing',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'typing test' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.equal(sdk.reactions[0]?.type, 'create');
  assert.equal(sdk.reactions[0]?.payload?.path?.message_id, 'om_typing_1');
  assert.equal(sdk.reactions[0]?.payload?.data?.reaction_type?.emoji_type, 'Typing');
  assert.equal(sdk.reactions.at(-1)?.type, 'delete');
  assert.equal(sdk.reactions.at(-1)?.payload?.path?.message_id, 'om_typing_1');
  assert.equal(readFeishuContent(sdk.sent.at(-1)), '普通最终结果');
});

test('bootstrap ignores duplicate feishu websocket deliveries for the same message id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-dedup-'));
  const sdk = createFeishuSdkSpy();
  const runtimeClient = new FakeRuntimeClient({ text: '只回复一次' });
  const app = await bootstrap({
    config: feishuConfigFor(dir),
    runtimeClient,
    feishuSdk: sdk
  });

  const rawEvent = {
    message: {
      message_id: 'om_dup_1',
      chat_id: 'oc_dup',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'repeat this once' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  };

  await app.channelHost.dispatchRawEvent('feishu', { accountId: 'appid', ...rawEvent });
  await app.channelHost.dispatchRawEvent('feishu', { accountId: 'appid', ...rawEvent });

  assert.equal(runtimeClient.calls.length, 1);
  assert.equal(sdk.sent.length, 1);
  assert.equal(readFeishuContent(sdk.sent.at(-1)), '只回复一次');
});

test('bootstrap preserves final feishu text when streaming has no chunks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-stream-no-chunks-'));
  const sdk = createFeishuSdkSpy();
  const runtimeClient = new FakeRuntimeClient({ text: '没有 chunk 也要有最终结果' });
  runtimeClient.runTurn = async ({ runtimeHandle, messageText }) => {
    runtimeClient.calls.push(messageText);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { text: '没有 chunk 也要有最终结果', runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
  };
  const config = feishuConfigFor(dir);
  config.channel.feishu.streaming = true;

  const app = await bootstrap({
    config,
    runtimeClient,
    feishuSdk: sdk
  });

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid',
    message: {
      message_id: 'om_stream_no_chunks_1',
      chat_id: 'oc_stream_no_chunks',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'need final text only' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_123', user_id: 'u_123', union_id: 'un_123' }
    }
  });

  assert.equal(readFeishuContent(sdk.sent.at(-1)), '没有 chunk 也要有最终结果');
});

test('bootstrap routes different feishu accounts to different agent instances', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-accounts-'));
  const sent = [];
  const sdk = {
    sent,
    createClient: ({ appId }) => ({
      request: async () => ({ data: { pingBotInfo: { botID: `bot_${appId}` } } }),
      im: {
        message: {
          create: async (payload) => {
            sent.push(payload);
            return { data: { message_id: `om_${sent.length}` } };
          },
          reply: async (payload) => {
            sent.push(payload);
            return { data: { message_id: `om_${sent.length}` } };
          }
        }
      }
    }),
    createEventDispatcher: () => ({ register() {} }),
    createWsClient: () => ({ start() {}, close() {} })
  };
  const calls = [];
  const runtimeClient = {
    async ensureSession({ agentId, sessionName }) {
      return { backend: 'acpx', runtimeSessionName: sessionName ?? agentId, sessionKey: `${agentId}:${sessionName}` };
    },
    async runTurn({ messageText, runtimeHandle, agentId }) {
      calls.push({ messageText, runtimeHandle, agentId });
      return { text: 'ok', runtimeHandle, exitCode: 0, stderr: '', stopReason: 'end_turn' };
    },
    async close() { return { ok: true }; }
  };
  const config = {
    runtime: { dataDir: dir },
    channel: {
      feishu: {
        enabled: true,
        groupAllowFrom: ['ou_1', 'ou_2'],
        accounts: {
          'appid-default': {
            appSecret: 'secret-default',
            bindings: { dm: { ou_1: { instanceId: 'codex_cc' } }, group: {} }
          },
          'appid-review': {
            appSecret: 'secret-review',
            bindings: { dm: { ou_2: { instanceId: 'claude_cc' } }, group: {} }
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
      telegram: { dm: {}, group: {}, topic: {} },
      feishu: {
        dm: {},
        group: {},
        accounts: {
          'appid-default': { dm: { ou_1: { instanceId: 'codex_cc' } }, group: {} },
          'appid-review': { dm: { ou_2: { instanceId: 'claude_cc' } }, group: {} }
        }
      }
    },
    session: {},
    logging: { dir },
    secrets: {
      feishuAccounts: {
        'appid-default': { appId: 'appid-default', appSecret: 'secret-default' },
        'appid-review': { appId: 'appid-review', appSecret: 'secret-review' }
      }
    }
  };

  const app = await bootstrap({ config, runtimeClient, feishuSdk: sdk });
  await app.feishuPlugin.ensureAccountState('appid-default');
  await app.feishuPlugin.ensureAccountState('appid-review');

  await app.channelHost.dispatchRawEvent('feishu', {
    accountId: 'appid-review',
    data: {
      message: {
        message_id: 'om_review_1',
        chat_id: 'oc_review',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello review' }),
        create_time: String(Date.now())
      },
      sender: {
        sender_id: { open_id: 'ou_2', user_id: 'u_2' }
      }
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(sent.length > 0, true);
});
