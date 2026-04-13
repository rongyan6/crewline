import test from 'node:test';
import assert from 'node:assert/strict';
import { WechatChannelPlugin } from '../../src/channel/wechat/wechat-plugin.js';

test('wechat plugin delegates send and healthcheck to bridge helpers', async () => {
  const calls = [];
  const plugin = new WechatChannelPlugin({
    config: { enabled: true },
    dataDir: '/tmp/crewline-wechat-plugin',
    bridge: {
      listAccounts() {
        calls.push(['listAccounts']);
        return [];
      },
      normalizeInbound({ accountId }) {
        calls.push(['normalizeInbound', accountId]);
        return {
          accountId,
          conversationRef: { channel: 'wechat', conversationId: 'wxid_alice', participantId: 'wxid_alice', scope: 'dm' },
          senderRef: { userId: 'wxid_alice' },
          messageId: 'm-in',
          text: 'hello inbound',
          timestamp: new Date().toISOString(),
          rawMeta: {}
        };
      },
      async poll() {
        calls.push(['poll']);
      },
      resolveConfig() {
        calls.push(['resolveConfig']);
        return {};
      },
      async send(input) {
        calls.push(['send', input]);
        return { ok: true, messageId: 'm1' };
      },
      async probe(input) {
        calls.push(['probe', input]);
        return { ok: true, channel: 'wechat' };
      }
    }
  });

  const sendResult = await plugin.send({
    conversationRef: { conversationId: 'wxid_alice' },
    text: 'hello'
  });
  const inbound = await plugin.toInbound({
    accountId: 'wxbot@im.bot',
    message: {
      item_list: [{ type: 1, text_item: { text: 'hello inbound' } }]
    }
  });
  const health = await plugin.healthcheck();

  assert.equal(sendResult.messageId, 'm1');
  assert.equal(inbound[0].text, 'hello inbound');
  assert.equal(health.ok, true);
  assert.equal(calls[0][0], 'send');
  assert.equal(calls.at(-1)[0], 'probe');
});

test('wechat plugin creates typing session through bridge hooks', async () => {
  const calls = [];
  const plugin = new WechatChannelPlugin({
    config: { enabled: true },
    dataDir: '/tmp/crewline-wechat-plugin',
    bridge: {
      listAccounts() { return []; },
      normalizeInbound() { return null; },
      async poll() {},
      resolveConfig() { return {}; },
      async send() { return { ok: true, messageId: 'm1' }; },
      async probe() { return { ok: true, channel: 'wechat' }; },
      async getTypingConfig(input) {
        calls.push(['getTypingConfig', input]);
        return { typingTicket: 'ticket-1' };
      },
      async sendTyping(input) {
        calls.push(['sendTyping', input]);
        return true;
      }
    }
  });

  const stopTyping = await plugin.createTypingSession({
    accountId: 'wxbot@im.bot',
    conversationRef: { participantId: 'wxid_alice' },
    rawMeta: { contextToken: 'ctx-1' }
  });
  await stopTyping?.();

  assert.equal(calls[0][0], 'getTypingConfig');
  assert.equal(calls[1][0], 'sendTyping');
  assert.equal(calls[1][1].status, 1);
  assert.equal(calls[2][1].status, 2);
});

test('wechat plugin refreshes typing ticket when context token changes', async () => {
  const calls = [];
  const plugin = new WechatChannelPlugin({
    config: { enabled: true },
    dataDir: '/tmp/crewline-wechat-plugin',
    bridge: {
      listAccounts() { return []; },
      normalizeInbound() { return null; },
      async poll() {},
      resolveConfig() { return {}; },
      async send() { return { ok: true, messageId: 'm1' }; },
      async probe() { return { ok: true, channel: 'wechat' }; },
      async getTypingConfig(input) {
        calls.push(['getTypingConfig', input]);
        return { typingTicket: `ticket-${input.contextToken}` };
      },
      async sendTyping(input) {
        calls.push(['sendTyping', input]);
        return true;
      }
    }
  });

  const firstStop = await plugin.createTypingSession({
    accountId: 'wxbot@im.bot',
    conversationRef: { participantId: 'wxid_alice' },
    rawMeta: { contextToken: 'ctx-1' }
  });
  await firstStop?.();
  const secondStop = await plugin.createTypingSession({
    accountId: 'wxbot@im.bot',
    conversationRef: { participantId: 'wxid_alice' },
    rawMeta: { contextToken: 'ctx-2' }
  });
  await secondStop?.();

  assert.equal(calls.filter(([name]) => name === 'getTypingConfig').length, 2);
  assert.equal(calls[1][1].typingTicket, 'ticket-ctx-1');
  assert.equal(calls[4][1].typingTicket, 'ticket-ctx-2');
});

test('wechat plugin handles slash commands locally', async () => {
  const plugin = new WechatChannelPlugin({
    config: { enabled: true },
    dataDir: '/tmp/crewline-wechat-plugin-local',
    bridge: {
      listAccounts() { return []; },
      normalizeInbound({ accountId }) {
        return {
          accountId,
          conversationRef: { channel: 'wechat', conversationId: 'wxid_alice', participantId: 'wxid_alice', scope: 'dm' },
          senderRef: { userId: 'wxid_alice' },
          messageId: 'm-in',
          text: '/echo hello',
          timestamp: new Date().toISOString(),
          rawMeta: {}
        };
      },
      async poll() {},
      resolveConfig() { return { cdnBaseUrl: 'https://cdn-wechat.example' }; },
      async send() { return { ok: true, messageId: 'm1' }; },
      async probe() { return { ok: true, channel: 'wechat' }; },
      resolveSlashCommand({ text }) {
        return { handled: true, localReplyText: `echo:${text}` };
      }
    }
  });

  const inbound = await plugin.toInbound({
    accountId: 'wxbot@im.bot',
    message: {
      item_list: [{ type: 1, text_item: { text: '/echo hello' } }]
    }
  });

  assert.equal(inbound[0].rawMeta.localReplyText, 'echo:/echo hello');
});
