import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { applyWechatAutoBinding, persistWechatAutoBinding } from '../../src/app/wechat-command.js';

test('applyWechatAutoBinding replaces pending placeholder with real wechat user id', () => {
  const updated = applyWechatAutoBinding({
    agents: {
      instances: {
        codex_cc: { providerId: 'codex', cwd: '/tmp' }
      }
    },
    channel: {
      wechat: {
        bindings: {
          dm: {
            'pending-wechat-user-id': { instanceId: 'codex_cc' }
          }
        }
      }
    }
  }, { accountId: 'bot@im.bot', userId: 'wxid_real' });

  assert.deepEqual(updated.channel.wechat.accounts, {
    'bot@im.bot': {
      bindings: {
        dm: {
          wxid_real: { instanceId: 'codex_cc' }
        }
      }
    }
  });
  assert.equal(updated.channel.wechat.bindings, undefined);
});

test('applyWechatAutoBinding updates existing account entry in accounts array', () => {
  const updated = applyWechatAutoBinding({
    agents: {
      instances: {
        codex_cc: { providerId: 'codex', cwd: '/tmp' }
      }
    },
    channel: {
      wechat: {
        accounts: [
          {
            accountId: 'bot@im.bot',
            bindings: {
              dm: {
                'pending-wechat-user-id': { instanceId: 'codex_cc' }
              }
            }
          }
        ]
      }
    }
  }, { accountId: 'bot@im.bot', userId: 'wxid_real' });

  assert.deepEqual(updated.channel.wechat.accounts['bot@im.bot'].bindings.dm, {
    wxid_real: { instanceId: 'codex_cc' }
  });
});

test('applyWechatAutoBinding auto-binds first instance when dm bindings are empty', () => {
  const updated = applyWechatAutoBinding({
    agents: {
      instances: {
        claude_cc: { providerId: 'claude', cwd: '/tmp' },
        codex_cc: { providerId: 'codex', cwd: '/tmp' }
      }
    },
    channel: {
      wechat: {
        accounts: {}
      }
    }
  }, { accountId: 'bot@im.bot', userId: 'wxid_real' });

  assert.deepEqual(updated.channel.wechat.accounts, {
    'bot@im.bot': {
      bindings: {
        dm: {
          wxid_real: { instanceId: 'codex_cc' }
        }
      }
    }
  });
});

test('persistWechatAutoBinding writes updated config to disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-config-'));
  const configPath = path.join(dir, 'crewline.json');
  const userConfig = {
    agents: {
      instances: {
        codex_cc: { providerId: 'codex', cwd: '/tmp' }
      }
    },
    channel: {
      wechat: {
        bindings: {
          dm: {
            'pending-wechat-user-id': { instanceId: 'codex_cc' }
          }
        }
      }
    }
  };

  await persistWechatAutoBinding({
    configPath,
    userConfig,
    accountId: 'bot@im.bot',
    userId: 'wxid_real'
  });

  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(saved.channel.wechat.accounts['bot@im.bot'].bindings.dm.wxid_real.instanceId, 'codex_cc');
  assert.equal(saved.channel.wechat.bindings, undefined);
});
