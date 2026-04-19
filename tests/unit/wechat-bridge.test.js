import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_WECHAT_API_BASE_URL,
  assertWechatSessionActive,
  getContextToken,
  getWechatTypingConfig,
  listWechatAccounts,
  loginWechatChannel,
  normalizeWechatInboundEvent,
  pauseWechatSession,
  probeWechatChannel,
  resolveWechatBridgeConfig,
  saveWechatAccount,
  sendWechatMessage
} from '../../src/channel/wechat/wechat-bridge.js';

function createJsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

test('resolveWechatBridgeConfig derives a Crewline-local state directory', () => {
  const bridgeConfig = resolveWechatBridgeConfig({
    apiBaseUrl: 'https://example.com',
    bindings: { dm: { wxid_alice: { instanceId: 'codex' } } }
  }, {
    dataDir: '/tmp/crewline-data'
  });

  assert.equal(bridgeConfig.apiBaseUrl, 'https://example.com');
  assert.equal(bridgeConfig.stateDir, '/tmp/crewline-data/channels/wechat');
  assert.equal(bridgeConfig.botType, '3');
});

test('loginWechatChannel stores account data after QR confirmation', async () => {
  const dataDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-login-'))
  );
  const fetchCalls = [];
  const responses = [
    createJsonResponse({
      qrcode: 'qr-token',
      qrcode_img_content: 'https://qrcode.example/1'
    }),
    createJsonResponse({
      status: 'confirmed',
      bot_token: 'bot-token',
      ilink_bot_id: 'wxbot@im.bot',
      baseurl: 'https://api.weixin.qq.com',
      ilink_user_id: 'wxid_owner'
    })
  ];

  const result = await loginWechatChannel({
    config: {},
    dataDir,
    print: () => undefined,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
      return responses.shift();
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.accountId, 'wxbot@im.bot');
  const bridgeConfig = resolveWechatBridgeConfig({}, { dataDir });
  const accounts = listWechatAccounts({ bridgeConfig });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].token, 'bot-token');
  assert.equal(accounts[0].baseUrl, 'https://api.weixin.qq.com');
  assert.deepEqual(fetchCalls.map((call) => call.method), ['GET', 'GET']);
});

test('loginWechatChannel rejects untrusted api hosts returned by login confirmation', async () => {
  const dataDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-login-untrusted-'))
  );
  const responses = [
    createJsonResponse({
      qrcode: 'qr-token',
      qrcode_img_content: 'https://qrcode.example/1'
    }),
    createJsonResponse({
      status: 'confirmed',
      bot_token: 'bot-token',
      ilink_bot_id: 'wxbot@im.bot',
      baseurl: 'https://evil.example',
      ilink_user_id: 'wxid_owner'
    })
  ];

  const result = await loginWechatChannel({
    config: {},
    dataDir,
    print: () => undefined,
    fetchImpl: async () => responses.shift()
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /不受信任/);
  const bridgeConfig = resolveWechatBridgeConfig({}, { dataDir });
  assert.equal(listWechatAccounts({ bridgeConfig }).length, 0);
});

test('saveWechatAccount clears stale account files for the same user id', async () => {
  const dataDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-account-'))
  );
  const bridgeConfig = resolveWechatBridgeConfig({}, { dataDir });
  saveWechatAccount({
    bridgeConfig,
    accountId: 'wxbot-old',
    account: { token: 'old-token', userId: 'wxid_owner' }
  });
  saveWechatAccount({
    bridgeConfig,
    accountId: 'wxbot-new',
    account: { token: 'new-token', userId: 'wxid_owner' }
  });
  const accounts = listWechatAccounts({ bridgeConfig });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountId, 'wxbot-new');
});

test('normalizeWechatInboundEvent persists context token and returns Crewline-shaped payload', async () => {
  const dataDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-inbound-'))
  );
  const bridgeConfig = resolveWechatBridgeConfig({}, { dataDir });

  const inbound = normalizeWechatInboundEvent({
    accountId: 'wxbot@im.bot',
    bridgeConfig,
    message: {
      message_id: 7,
      from_user_id: 'wxid_alice',
      create_time_ms: 1710000000000,
      context_token: 'ctx-1',
      item_list: [{
        type: 1,
        text_item: { text: 'hello wechat' }
      }]
    }
  });

  assert.equal(inbound.text, 'hello wechat');
  assert.equal(inbound.conversationRef.channel, 'wechat');
  assert.equal(getContextToken({
    bridgeConfig,
    accountId: 'wxbot@im.bot',
    userId: 'wxid_alice'
  }), 'ctx-1');
});

test('sendWechatMessage posts directly to ilink sendmessage with stored token/context', async () => {
  const dataDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-send-'))
  );
  const bridgeConfig = resolveWechatBridgeConfig({}, { dataDir });
  saveWechatAccount({
    bridgeConfig,
    accountId: 'wxbot@im.bot',
    account: {
      token: 'bot-token',
      baseUrl: 'https://api-wechat.example',
      userId: 'wxid_owner'
    }
  });
  normalizeWechatInboundEvent({
    accountId: 'wxbot@im.bot',
    bridgeConfig,
    message: {
      from_user_id: 'wxid_alice',
      context_token: 'ctx-2',
      item_list: [{ type: 1, text_item: { text: 'hi' } }]
    }
  });

  let body = null;
  const result = await sendWechatMessage({
    config: {},
    dataDir,
    outboundMessage: {
      accountId: 'wxbot@im.bot',
      conversationRef: { participantId: 'wxid_alice', conversationId: 'wxid_alice' },
      text: 'reply text'
    },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return createJsonResponse({});
    }
  });

  assert.equal(result.ok, true);
  assert.equal(body.msg.to_user_id, 'wxid_alice');
  assert.equal(body.msg.context_token, 'ctx-2');
  assert.equal(body.msg.item_list[0].text_item.text, 'reply text');
});

test('sendWechatMessage routes unified attachments through outbound media upload flow', async () => {
  const dataDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-send-attachment-'))
  );
  const bridgeConfig = resolveWechatBridgeConfig({}, { dataDir });
  saveWechatAccount({
    bridgeConfig,
    accountId: 'wxbot@im.bot',
    account: {
      token: 'bot-token',
      baseUrl: 'https://api-wechat.example',
      userId: 'wxid_owner'
    }
  });
  normalizeWechatInboundEvent({
    accountId: 'wxbot@im.bot',
    bridgeConfig,
    message: {
      from_user_id: 'wxid_alice',
      context_token: 'ctx-3',
      item_list: [{ type: 1, text_item: { text: 'hi' } }]
    }
  });
  const imagePath = path.join(dataDir, 'report.png');
  await import('node:fs/promises').then((fs) => fs.writeFile(imagePath, 'image-bytes', 'utf8'));

  const sendBodies = [];
  const result = await sendWechatMessage({
    config: {},
    dataDir,
    outboundMessage: {
      accountId: 'wxbot@im.bot',
      conversationRef: { participantId: 'wxid_alice', conversationId: 'wxid_alice' },
      text: 'reply with image',
      attachments: [{ localPath: imagePath, kind: 'image' }]
    },
    fetchImpl: async (url, init) => {
      if (String(url).includes('/getuploadurl')) {
        return createJsonResponse({ upload_param: 'upload-token' });
      }
      if (String(url).startsWith('https://novac2c.cdn.weixin.qq.com/c2c/upload')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: {
            get(name) {
              return name.toLowerCase() === 'x-encrypted-param' ? 'download-token' : null;
            }
          },
          async text() {
            return '';
          }
        };
      }
      if (String(url).includes('/sendmessage')) {
        const parsed = JSON.parse(init.body);
        sendBodies.push(parsed);
        return createJsonResponse({});
      }
      throw new Error(`unexpected url: ${url}`);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(sendBodies.length, 1);
  assert.equal(sendBodies[0].msg.to_user_id, 'wxid_alice');
  assert.equal(sendBodies[0].msg.context_token, 'ctx-3');
  assert.equal(sendBodies[0].msg.item_list[0].text_item.text, 'reply with image');
  assert.equal(sendBodies[0].msg.item_list[1].type, 2);
});

test('getWechatTypingConfig falls back to stored context token for the same user', async () => {
  const dataDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-typing-config-'))
  );
  const bridgeConfig = resolveWechatBridgeConfig({}, { dataDir });
  saveWechatAccount({
    bridgeConfig,
    accountId: 'wxbot@im.bot',
    account: {
      token: 'bot-token',
      baseUrl: 'https://api-wechat.example',
      userId: 'wxid_owner'
    }
  });
  normalizeWechatInboundEvent({
    accountId: 'wxbot@im.bot',
    bridgeConfig,
    message: {
      from_user_id: 'wxid_alice',
      context_token: 'ctx-typing',
      item_list: [{ type: 1, text_item: { text: 'hi' } }]
    }
  });

  let body = null;
  const result = await getWechatTypingConfig({
    config: {},
    dataDir,
    accountId: 'wxbot@im.bot',
    userId: 'wxid_alice',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return createJsonResponse({ typing_ticket: 'ticket-1' });
    }
  });

  assert.equal(result.typingTicket, 'ticket-1');
  assert.equal(body.ilink_user_id, 'wxid_alice');
  assert.equal(body.context_token, 'ctx-typing');
});

test('probeWechatChannel reports whether any logged-in accounts exist', async () => {
  const dataDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-probe-'))
  );
  let probe = await probeWechatChannel({ config: {}, dataDir });
  assert.equal(probe.ok, false);

  const bridgeConfig = resolveWechatBridgeConfig({}, { dataDir });
  saveWechatAccount({
    bridgeConfig,
    accountId: 'wxbot@im.bot',
    account: {
      token: 'bot-token',
      baseUrl: DEFAULT_WECHAT_API_BASE_URL
    }
  });
  probe = await probeWechatChannel({ config: {}, dataDir });
  assert.equal(probe.ok, true);
  assert.equal(probe.accountCount, 1);
});

test('wechat session guard blocks paused accounts', () => {
  pauseWechatSession('wxbot@im.bot');
  assert.throws(() => assertWechatSessionActive('wxbot@im.bot'));
});
