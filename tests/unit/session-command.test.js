import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatSessionHelp, parseSessionCommand, runSessionCommand } from '../../src/app/session-command.js';
import { runtimeBindingPath } from '../../src/channel/host/conversation-ref.js';

function feishuConfig(dir) {
  return {
    runtime: {
      dataDir: dir,
      acpxTurnTimeoutMs: 600000,
      acpxQueueTtlSeconds: 300
    },
    agents: {
      providers: {
        claude: {
          driver: 'acpx',
          agent: 'claude'
        }
      },
      instances: {
        claude_wechat: {
          providerId: 'claude',
          cwd: '/tmp/crewline-session-command'
        }
      }
    },
    bindings: {
      feishu: {
        accounts: {
          cli_app: {
            dm: {
              ou_user_1: {
                instanceId: 'claude_wechat'
              }
            },
            group: {}
          }
        }
      }
    },
    channel: {
      feishu: {
        enabled: true,
        accounts: {
          cli_app: {
            appSecret: 'secret',
            bindings: {
              dm: {
                ou_user_1: {
                  instanceId: 'claude_wechat'
                }
              },
              group: {}
            }
          }
        }
      }
    }
  };
}

test('parseSessionCommand accepts reset targets', () => {
  const spec = parseSessionCommand({
    argv: ['reset', 'feishu', '--account', 'cli_app', '--chat-id', 'oc_1', '--scope', 'dm', '--participant-id', 'ou_1']
  });

  assert.equal(spec.action, 'reset');
  assert.equal(spec.channel, 'feishu');
  assert.equal(spec.accountId, 'cli_app');
  assert.equal(spec.target.chatId, 'oc_1');
  assert.equal(spec.target.scope, 'dm');
  assert.equal(spec.target.participantId, 'ou_1');
});

test('runSessionCommand delegates list mode to push list handler', async () => {
  const calls = [];
  const result = await runSessionCommand({
    argv: ['list', 'telegram', '--account', 'bot_1'],
    runListCommand: async (input) => {
      calls.push(input);
      return { ok: true, channel: 'telegram', targets: { dm: [], group: [], topic: [] } };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'telegram');
  assert.deepEqual(calls[0].argv, ['--list', '--account', 'bot_1']);
});

test('runSessionCommand closes and deletes an existing runtime binding', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-command-'));
  const config = feishuConfig(dir);
  const conversationRef = {
    channel: 'feishu',
    accountId: 'cli_app',
    conversationId: 'oc_dm_1',
    participantId: 'ou_user_1',
    scope: 'dm'
  };
  const bindingPath = runtimeBindingPath({ dataDir: dir, conversationRef });
  await fs.mkdir(path.dirname(bindingPath), { recursive: true });
  await fs.writeFile(bindingPath, JSON.stringify({
    sessionId: 'session_old',
    bindingState: 'active',
    agentName: 'claude',
    resolvedCwd: '/tmp/crewline-session-command',
    runtimeHandle: {
      backend: 'acpx',
      runtimeSessionName: 'feishu:cli_app:dm:oc_dm_1',
      sessionKey: 'claude:feishu:cli_app:dm:oc_dm_1'
    }
  }), 'utf8');

  const closeCalls = [];
  const result = await runSessionCommand({
    argv: ['reset', 'feishu', '--account', 'cli_app', '--chat-id', 'oc_dm_1', '--scope', 'dm', '--participant-id', 'ou_user_1'],
    loadRuntimeConfig: async () => ({ config }),
    runtimeGateway: {
      async close(input) {
        closeCalls.push(input);
        return { ok: true };
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.hadRuntimeBinding, true);
  assert.equal(result.closedRuntime, true);
  assert.equal(result.bindingDeleted, true);
  assert.equal(result.route.agentName, 'claude');
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].agentId, 'claude');
  assert.equal(closeCalls[0].runtimeHandle.runtimeSessionName, 'feishu:cli_app:dm:oc_dm_1');
  await assert.rejects(() => fs.readFile(bindingPath, 'utf8'), /ENOENT/);
});

test('runSessionCommand resets cleanly when no runtime binding exists yet', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-command-empty-'));
  const config = feishuConfig(dir);
  const closeCalls = [];

  const result = await runSessionCommand({
    argv: ['reset', 'feishu', '--account', 'cli_app', '--chat-id', 'oc_dm_1', '--scope', 'dm', '--participant-id', 'ou_user_1'],
    loadRuntimeConfig: async () => ({ config }),
    runtimeGateway: {
      async close(input) {
        closeCalls.push(input);
        return { ok: true };
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.hadRuntimeBinding, false);
  assert.equal(result.closedRuntime, false);
  assert.equal(closeCalls.length, 0);
});

test('formatSessionHelp documents list and reset forms', () => {
  const help = formatSessionHelp();

  assert.match(help, /crewline session list telegram/);
  assert.match(help, /crewline session reset feishu/);
  assert.match(help, /next inbound message/);
});
