import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatTriggerHelp, parseTriggerCommand, runTriggerCommand } from '../../src/app/trigger-command.js';

test('parseTriggerCommand normalizes telegram targets', () => {
  const spec = parseTriggerCommand({
    channel: 'telegram',
    argv: ['--account', 'bot_1', '--chat-id', '-100123', '--topic-id', '42', '--text', 'hello']
  });

  assert.equal(spec.channel, 'telegram');
  assert.equal(spec.accountId, 'bot_1');
  assert.equal(spec.target.chatId, '-100123');
  assert.equal(spec.target.topicId, '42');
  assert.equal(spec.text, 'hello');
});

test('runTriggerCommand delegates list mode to push list handler', async () => {
  const calls = [];
  const result = await runTriggerCommand({
    channel: 'telegram',
    argv: ['--list'],
    runListCommand: async (input) => {
      calls.push(input);
      return { ok: true, channel: 'telegram', targets: { dm: [], group: [], topic: [] } };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'telegram');
  assert.deepEqual(calls[0].argv, ['--list']);
});

test('runTriggerCommand resolves feishu dm participant id from runtime history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-trigger-feishu-'));
  const runtimeDir = path.join(dir, 'conversations', 'feishu', 'cli_app', 'dm');
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(
    path.join(runtimeDir, 'oc_dm_1.jsonl'),
    `${JSON.stringify({
      channel: 'feishu',
      scope: 'dm',
      conversationId: 'oc_dm_1',
      participantId: 'ou_user_1',
      accountId: 'cli_app'
    })}\n`,
    'utf8'
  );

  const calls = [];
  const result = await runTriggerCommand({
    channel: 'feishu',
    argv: ['--chat-id', 'oc_dm_1', '--text', '新告警'],
    loadRuntimeConfig: async () => ({
      config: {
        runtime: { dataDir: dir },
        channel: {
          feishu: {
            enabled: true,
            accounts: {
              cli_app: {
                appSecret: 'secret',
                bindings: { dm: { ou_user_1: { instanceId: 'codex_cc' } }, group: {} }
              }
            }
          }
        }
      }
    }),
    createApp: async () => ({
      async triggerInbound(payload) {
        calls.push(payload);
        return {
          noticeSendResult: { messageId: 'om_notice_1' },
          triggerResult: {
            session: { sessionId: 'session_1' },
            result: { ok: true, outputText: 'done' }
          }
        };
      }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.noticeMessageId, 'om_notice_1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].noticeText, '触发：新告警');
  assert.equal(calls[0].inboundMessage.text, '触发：新告警');
  assert.equal(calls[0].inboundMessage.conversationRef.scope, 'dm');
  assert.equal(calls[0].inboundMessage.conversationRef.participantId, 'ou_user_1');
  assert.equal(calls[0].inboundMessage.accountId, 'cli_app');
});

test('runTriggerCommand rejects telegram trigger without account in multi-account config', async () => {
  await assert.rejects(() => runTriggerCommand({
    channel: 'telegram',
    argv: ['--chat-id', '-100123', '--text', '部署失败'],
    loadRuntimeConfig: async () => ({
      config: {
        runtime: { dataDir: '/tmp/crewline-test' },
        channel: {
          telegram: {
            accounts: {
              bot1: { botToken: 'bot1:token', bindings: { dm: {}, group: {}, topic: {} } },
              bot2: { botToken: 'bot2:token', bindings: { dm: {}, group: {}, topic: {} } }
            }
          }
        }
      }
    }),
    createApp: async () => {
      throw new Error('should not create app');
    }
  }), /Telegram trigger requires `--account`/);
});

test('runTriggerCommand reads trigger text from stdin', async () => {
  const calls = [];
  const result = await runTriggerCommand({
    channel: 'wechat',
    argv: ['--account', 'bot@im.bot', '--user-id', 'wxid_1', '--stdin'],
    stdin: Readable.from(['定时巡检']),
    loadRuntimeConfig: async () => ({ config: { runtime: { dataDir: '/tmp/crewline-test' }, channel: {} } }),
    createApp: async () => ({
      async triggerInbound(payload) {
        calls.push(payload);
        return {
          noticeSendResult: { messageId: 'wx_notice_1' },
          triggerResult: {
            session: { sessionId: 'session_2' },
            result: { ok: true, outputText: 'ok' }
          }
        };
      }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].noticeText, '触发：定时巡检');
  assert.equal(calls[0].inboundMessage.conversationRef.participantId, 'wxid_1');
});

test('formatTriggerHelp documents trigger command forms', () => {
  const help = formatTriggerHelp();

  assert.match(help, /crewline trigger telegram --list/);
  assert.match(help, /crewline trigger feishu/);
  assert.match(help, /crewline trigger wechat/);
  assert.match(help, /触发：/);
});
