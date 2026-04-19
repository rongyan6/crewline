import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { FeishuChannelPlugin } from '../../src/channel/feishu/feishu-plugin.js';
import { parseFeishuMessageText, resolveUnsupportedFeishuReply } from '../../src/channel/feishu/feishu-parser.js';

function feishuConfig(overrides = {}) {
  return {
    enabled: true,
    groupAllowFrom: ['ou_owner'],
    accounts: {
      appid: {
        appSecret: 'secret',
        bindings: { dm: {}, group: {} }
      }
    },
    ...overrides
  };
}

test('parseFeishuMessageText handles text content', () => {
  const text = parseFeishuMessageText({
    message_type: 'text',
    content: JSON.stringify({ text: '你好，飞书' })
  });
  assert.equal(text, '你好，飞书');
});

test('parseFeishuMessageText handles post content', () => {
  const text = parseFeishuMessageText({
    message_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: '标题',
        content: [[{ tag: 'text', text: '第一行' }], [{ tag: 'text', text: '第二行' }]]
      }
    })
  });
  assert.equal(text, '标题\n第一行\n第二行');
});

test('resolveUnsupportedFeishuReply returns user-facing fallback', () => {
  assert.match(resolveUnsupportedFeishuReply('image'), /暂不支持的飞书消息类型：image/);
});

test('feishu plugin converts inbound text event into Crewline inbound message', async () => {
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig(),
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        im: { message: { create: async () => ({ data: { message_id: 'm1' } }) } }
      }),
      createEventDispatcher: () => ({ register() {} }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });
  await plugin.start({ emitRawEvent: async () => {} });

  const inbound = await plugin.toInbound({
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
      sender_id: { open_id: 'ou_1', user_id: 'u_1', union_id: 'un_1' }
    }
  });

  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].channel, 'feishu');
  assert.equal(inbound[0].text, 'hello feishu');
  assert.equal(inbound[0].conversationRef.scope, 'dm');
});

test('feishu plugin deduplicates repeated inbound message ids', async () => {
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig(),
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        im: { message: { create: async () => ({ data: { message_id: 'm1' } }) } }
      }),
      createEventDispatcher: () => ({ register() {} }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });
  await plugin.start({ emitRawEvent: async () => {} });

  const event = {
    accountId: 'appid',
    message: {
      message_id: 'om_dup_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello again' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_1', user_id: 'u_1', union_id: 'un_1' }
    }
  };

  const first = await plugin.toInbound(event);
  const second = await plugin.toInbound(event);

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test('feishu plugin marks failed media download for local reply', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-plugin-'));
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig(),
    dataDir,
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        im: { message: { create: async () => ({ data: { message_id: 'm1' } }) } }
      }),
      createEventDispatcher: () => ({ register() {} }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });
  await plugin.start({ emitRawEvent: async () => {} });

  const inbound = await plugin.toInbound({
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
      sender_id: { open_id: 'ou_2' }
    }
  });

  assert.equal(inbound[0].conversationRef.scope, 'dm');
  assert.match(inbound[0].rawMeta.localReplyText, /Feishu 图片下载失败/);
});

test('feishu plugin sends outbound text to chat_id', async () => {
  const calls = [];
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig(),
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        im: {
          message: {
            create: async (payload) => {
              calls.push(payload);
              return { data: { message_id: 'om_3' } };
            }
          }
        }
      }),
      createEventDispatcher: () => ({ register() {} }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });
  await plugin.start({ emitRawEvent: async () => {} });

  const result = await plugin.send({
    channel: 'feishu',
    accountId: 'appid',
    conversationRef: { channel: 'feishu', conversationId: 'oc_3', participantId: 'ou_3', scope: 'group' },
    text: 'reply'
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].params.receive_id_type, 'chat_id');
  assert.equal(calls[0].data.receive_id, 'oc_3');
});

test('feishu plugin uploads outbound image attachments before sending image messages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-send-image-'));
  const imagePath = path.join(dir, 'chart.png');
  await fs.writeFile(imagePath, 'image-bytes', 'utf8');
  const messageCalls = [];
  const imageUploads = [];
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig(),
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        im: {
          image: {
            create: async (payload) => {
              imageUploads.push(payload);
              return { data: { image_key: 'img_out_1' } };
            }
          },
          file: {
            create: async () => {
              throw new Error('should not upload file');
            }
          },
          message: {
            create: async (payload) => {
              messageCalls.push(payload);
              return { data: { message_id: `om_img_${messageCalls.length}` } };
            }
          }
        }
      }),
      createEventDispatcher: () => ({ register() {} }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });
  await plugin.start({ emitRawEvent: async () => {} });

  const result = await plugin.send({
    channel: 'feishu',
    accountId: 'appid',
    conversationRef: { channel: 'feishu', conversationId: 'oc_img_1', participantId: 'ou_3', scope: 'group' },
    text: '图已生成',
    attachments: [{ localPath: imagePath, kind: 'image' }]
  });

  assert.equal(result.ok, true);
  assert.equal(imageUploads.length, 1);
  assert.equal(messageCalls.length, 2);
  assert.equal(messageCalls[0].data.msg_type, 'text');
  assert.equal(messageCalls[1].data.msg_type, 'image');
  assert.equal(JSON.parse(messageCalls[1].data.content).image_key, 'img_out_1');
});

test('feishu plugin uploads outbound file attachments before sending file messages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-send-file-'));
  const filePath = path.join(dir, 'report.pdf');
  await fs.writeFile(filePath, 'file-bytes', 'utf8');
  const messageCalls = [];
  const fileUploads = [];
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig(),
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        im: {
          image: {
            create: async () => {
              throw new Error('should not upload image');
            }
          },
          file: {
            create: async (payload) => {
              fileUploads.push(payload);
              return { data: { file_key: 'file_out_1' } };
            }
          },
          message: {
            create: async (payload) => {
              messageCalls.push(payload);
              return { data: { message_id: `om_file_${messageCalls.length}` } };
            }
          }
        }
      }),
      createEventDispatcher: () => ({ register() {} }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });
  await plugin.start({ emitRawEvent: async () => {} });

  const result = await plugin.send({
    channel: 'feishu',
    accountId: 'appid',
    conversationRef: { channel: 'feishu', conversationId: 'oc_file_1', participantId: 'ou_3', scope: 'group' },
    text: '',
    attachments: [{ localPath: filePath }]
  });

  assert.equal(result.ok, true);
  assert.equal(fileUploads.length, 1);
  assert.equal(fileUploads[0].data.file_name, 'report.pdf');
  assert.equal(messageCalls.length, 1);
  assert.equal(messageCalls[0].data.msg_type, 'file');
  assert.equal(JSON.parse(messageCalls[0].data.content).file_key, 'file_out_1');
});

test('feishu plugin streams with interactive card when account streaming is enabled', async () => {
  const calls = [];
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig({
      accounts: {
        appid: {
          appSecret: 'secret',
          streaming: true,
          footer: { elapsed: true, status: true },
          bindings: { dm: {}, group: {} }
        }
      }
    }),
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        im: {
          message: {
            create: async (payload) => {
              calls.push({ type: 'create', payload });
              return { data: { message_id: 'om_stream_1' } };
            },
            patch: async (payload) => {
              calls.push({ type: 'patch', payload });
              return { data: { message_id: 'om_stream_1' } };
            },
            reply: async (payload) => {
              calls.push({ type: 'reply', payload });
              return { data: { message_id: 'om_stream_1' } };
            }
          }
        }
      }),
      createEventDispatcher: () => ({ register() {} }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });

  await plugin.start({ emitRawEvent: async () => {} });
  await plugin.send({
    channel: 'feishu',
    accountId: 'appid',
    conversationRef: { channel: 'feishu', conversationId: 'oc_4', participantId: 'ou_4', scope: 'dm' },
    text: '最终文本',
    meta: {
      streamChunks: ['最', '终', '文', '本'],
      elapsedMs: 1234
    }
  });

  assert.equal(calls.some((entry) => entry.type === 'create'), true);
  assert.equal(calls.some((entry) => entry.type === 'patch'), true);
});

test('feishu plugin websocket dispatch does not block on slow inbound handling', async () => {
  let handler = null;
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig(),
    logger: { info() {}, warn() {}, error() {} },
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        im: { message: { create: async () => ({ data: { message_id: 'm1' } }) } }
      }),
      createEventDispatcher: () => ({
        register(map) {
          handler = map['im.message.receive_v1'];
        }
      }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });

  let settled = false;
  await plugin.start({
    emitRawEvent: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = true;
    }
  });

  const start = Date.now();
  await handler({
    message: {
      message_id: 'om_async_1',
      chat_id: 'oc_async',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello async' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_async' }
    }
  });

  assert.equal(Date.now() - start < 20, true);
  assert.equal(settled, false);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(settled, true);
});

test('feishu plugin websocket dispatch swallows downstream emit errors', async () => {
  let handler = null;
  let logged = null;
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig(),
    logger: {
      info() {},
      warn() {},
      error(...args) {
        logged = args;
      }
    },
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        im: { message: { create: async () => ({ data: { message_id: 'm1' } }) } }
      }),
      createEventDispatcher: () => ({
        register(map) {
          handler = map['im.message.receive_v1'];
        }
      }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });

  await plugin.start({
    emitRawEvent: async () => {
      throw new Error('boom');
    }
  });

  await handler({
    message: {
      message_id: 'om_async_err',
      chat_id: 'oc_async',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello async' }),
      create_time: String(Date.now())
    },
    sender: {
      sender_id: { open_id: 'ou_async' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(Array.isArray(logged), true);
  assert.match(String(logged[0]), /feishu\.event:appid/);
});

test('feishu plugin warns when requireMention=false but only @ mention scope is granted', async () => {
  const warnings = [];
  const plugin = new FeishuChannelPlugin({
    config: feishuConfig({
      requireMention: false
    }),
    logger: {
      info() {},
      error() {},
      warn(...args) {
        warnings.push(args);
      }
    },
    sdk: {
      createClient: () => ({
        request: async () => ({ data: { pingBotInfo: { botID: 'ou_bot' } } }),
        application: {
          scope: {
            list: async () => ({
              data: {
                scopes: [
                  {
                    scope_name: 'im:message.group_at_msg:readonly',
                    scope_type: 'tenant',
                    grant_status: 1
                  }
                ]
              }
            })
          }
        },
        im: { message: { create: async () => ({ data: { message_id: 'm1' } }) } }
      }),
      createEventDispatcher: () => ({ register() {} }),
      createWsClient: () => ({ start() {}, close() {} })
    }
  });

  await plugin.ensureAccountState('appid');

  assert.equal(warnings.length > 0, true);
  assert.match(String(warnings[0][0]), /requireMention=false/);
});
