import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatPushHelp, parsePushCommand, runPushCommand } from '../../src/app/push-command.js';

test('parsePushCommand normalizes telegram target parameters', () => {
  const spec = parsePushCommand({
    channel: 'telegram',
    argv: ['--account', 'bot_1', '--chat-id', '-100123', '--topic-id', '42', '--text', 'hello']
  });

  assert.equal(spec.channel, 'telegram');
  assert.equal(spec.accountId, 'bot_1');
  assert.equal(spec.conversationRef.conversationId, '-100123');
  assert.equal(spec.conversationRef.topicId, '42');
  assert.equal(spec.conversationRef.scope, 'topic');
  assert.equal(spec.text, 'hello');
});

test('parsePushCommand rejects missing wechat account', () => {
  assert.throws(() => parsePushCommand({
    channel: 'wechat',
    argv: ['--user-id', 'wxid_123', '--text', 'hello']
  }), /WeChat push requires `--account`/);
});

test('parsePushCommand accepts list mode without target arguments', () => {
  const spec = parsePushCommand({
    channel: 'telegram',
    argv: ['--list']
  });

  assert.equal(spec.channel, 'telegram');
  assert.equal(spec.list, true);
});

test('runPushCommand sends telegram message through plugin send', async () => {
  const calls = [];
  const result = await runPushCommand({
    channel: 'telegram',
    argv: ['--account', 'bot_1', '--chat-id', '-100888', '--topic-id', '7', '--text', 'deploy ok'],
    loadRuntimeConfig: async () => ({ config: { runtime: { dataDir: '/tmp/crewline-test' }, channel: {} } }),
    pluginFactories: {
      telegram: () => ({
        async send(outboundMessage) {
          calls.push(outboundMessage);
          return { ok: true, messageId: 'tg_1' };
        }
      })
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'tg_1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'telegram');
  assert.equal(calls[0].accountId, 'bot_1');
  assert.equal(calls[0].conversationRef.conversationId, '-100888');
  assert.equal(calls[0].conversationRef.topicId, '7');
  assert.equal(calls[0].text, 'deploy ok');
});

test('runPushCommand reads feishu message text from stdin', async () => {
  const calls = [];
  const result = await runPushCommand({
    channel: 'feishu',
    argv: ['--chat-id', 'oc_123', '--stdin'],
    stdin: Readable.from(['build passed']),
    loadRuntimeConfig: async () => ({ config: { runtime: { dataDir: '/tmp/crewline-test' }, channel: {} } }),
    pluginFactories: {
      feishu: () => ({
        async send(outboundMessage) {
          calls.push(outboundMessage);
          return { ok: true, messageId: 'fs_1' };
        }
      })
    }
  });

  assert.equal(result.channel, 'feishu');
  assert.equal(result.messageId, 'fs_1');
  assert.equal(calls[0].conversationRef.conversationId, 'oc_123');
  assert.equal(calls[0].text, 'build passed');
});

test('runPushCommand sends wechat message to explicit account and user id', async () => {
  const calls = [];
  const result = await runPushCommand({
    channel: 'wechat',
    argv: ['--account', 'bot@im.bot', '--user-id', 'wxid_123', '--text', 'done'],
    loadRuntimeConfig: async () => ({ config: { runtime: { dataDir: '/tmp/crewline-test' }, channel: {} } }),
    pluginFactories: {
      wechat: () => ({
        async send(outboundMessage) {
          calls.push(outboundMessage);
          return { ok: true, messageId: 'wx_1', target: outboundMessage.conversationRef.participantId };
        }
      })
    }
  });

  assert.equal(result.channel, 'wechat');
  assert.equal(result.target, 'wxid_123');
  assert.equal(calls[0].accountId, 'bot@im.bot');
  assert.equal(calls[0].conversationRef.participantId, 'wxid_123');
  assert.equal(calls[0].text, 'done');
});

test('runPushCommand lists telegram dm group and topic targets from config and runtime', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-push-list-'));
  const runtimeDir = path.join(dir, 'conversations', 'telegram', '8641929320', 'dm');
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(
    path.join(runtimeDir, '8657006361.jsonl'),
    `${JSON.stringify({
      channel: 'telegram',
      scope: 'dm',
      conversationId: '8657006361',
      participantId: '8657006361',
      topicId: null,
      accountId: '8641929320'
    })}\n`,
    'utf8'
  );

  const result = await runPushCommand({
    channel: 'telegram',
    argv: ['--list'],
    loadRuntimeConfig: async () => ({
      config: {
        runtime: { dataDir: dir },
        channel: {
          telegram: {
            accounts: {
              '8641929320': {
                botToken: '8641929320:token',
                bindings: {
                  dm: {
                    '8657006361': { instanceId: 'codex_cc' }
                  },
                  group: {
                    '-1003834739320': { instanceId: 'codex_cc' }
                  },
                  topic: {
                    '-1003834739320:2': { instanceId: 'codex_cc' }
                  }
                }
              }
            }
          }
        }
      }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.channel, 'telegram');
  assert.deepEqual(result.targets.dm, [{
    accountId: '8641929320',
    chatId: '8657006361',
    source: 'config'
  }]);
  assert.deepEqual(result.targets.group, [{
    accountId: '8641929320',
    chatId: '-1003834739320',
    source: 'config'
  }]);
  assert.deepEqual(result.targets.topic, [{
    accountId: '8641929320',
    chatId: '-1003834739320',
    topicId: '2',
    source: 'config'
  }]);
});

test('runPushCommand lists feishu dm chat ids from runtime conversations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-push-feishu-list-'));
  const runtimeDir = path.join(dir, 'conversations', 'feishu', 'cli_app', 'dm');
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(
    path.join(runtimeDir, 'oc_dm_xxx.jsonl'),
    `${JSON.stringify({
      channel: 'feishu',
      scope: 'dm',
      conversationId: 'oc_dm_xxx',
      participantId: 'ou_user_xxx',
      topicId: null,
      accountId: 'cli_app'
    })}\n`,
    'utf8'
  );

  const result = await runPushCommand({
    channel: 'feishu',
    argv: ['--list'],
    loadRuntimeConfig: async () => ({
      config: {
        runtime: { dataDir: dir },
        channel: {
          feishu: {
            enabled: true,
            accounts: {
              cli_app: {
                appSecret: 'secret',
                bindings: { dm: {}, group: {} }
              }
            }
          }
        }
      }
    })
  });

  assert.deepEqual(result.targets.dm, [{
    accountId: 'cli_app',
    chatId: 'oc_dm_xxx',
    participantId: 'ou_user_xxx',
    source: 'runtime'
  }]);
});

test('formatPushHelp documents all supported channel forms', () => {
  const help = formatPushHelp();

  assert.match(help, /--list/);
  assert.match(help, /crewline push telegram/);
  assert.match(help, /crewline push feishu/);
  assert.match(help, /crewline push wechat/);
  assert.match(help, /--stdin/);
});
