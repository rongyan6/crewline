import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../src/config/validate-config.js';
import { resolveConfig } from '../../src/config/resolve-config.js';

const agents = {
  providers: { codex: { driver: 'acpx', agent: 'codex' } },
  instances: { codex_cc: { providerId: 'codex', cwd: '/tmp' } }
};

test('validateConfig accepts minimal user config in channel.telegram shape', () => {
  const config = {
    channel: {
      telegram: {
        groupAllowFrom: ['123'],
        accounts: {
          '8641929320': {
            botToken: '8641929320:abc',
            bindings: { dm: { '123': { instanceId: 'codex_cc' } }, group: {}, topic: {} }
          }
        }
      }
    },
    agents
  };
  assert.equal(validateConfig(config, {}), true);
});

test('validateConfig accepts telegram bootstrap admin config without bindings', () => {
  const config = {
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
    agents
  };
  assert.equal(validateConfig(config, {}), true);
});

test('validateConfig accepts legacy telegram shape for backward compatibility', () => {
  const config = {
    telegram: { allowedUserIds: [123] },
    channel: {
      telegram: {
        accounts: {
          '8641929320': {
            botToken: '8641929320:abc',
            bindings: { dm: { '123': { instanceId: 'codex_cc' } }, group: {}, topic: {} }
          }
        }
      }
    },
    agents,
    bindings: { telegram: { dm: {}, group: {}, topic: {} } }
  };
  assert.equal(validateConfig(config, {}), true);
});

test('validateConfig accepts telegram multi-account shape with inline bot token', () => {
  const config = {
    channel: {
      telegram: {
        groupAllowFrom: ['123'],
        streaming: true,
        accounts: {
          '8641929320': {
            botToken: '8641929320:abc',
            streaming: false,
            bindings: { dm: { '123': { instanceId: 'codex_cc' } }, group: {}, topic: {} }
          }
        }
      }
    },
    agents
  };
  assert.equal(validateConfig(config, {}), true);
});

test('validateConfig rejects telegram account key that does not match botToken prefix', () => {
  assert.throws(() => validateConfig({
    channel: {
      telegram: {
        groupAllowFrom: ['123'],
        accounts: {
          '111': {
            botToken: '222:abc',
            bindings: { dm: { '123': { instanceId: 'codex_cc' } }, group: {}, topic: {} }
          }
        }
      }
    },
    agents
  }, {}));
});

test('validateConfig rejects missing secret', () => {
  assert.throws(() => validateConfig({
    channel: {
      telegram: {
        groupAllowFrom: ['1'],
        bindings: { dm: {}, group: {}, topic: {} }
      }
    },
    agents
  }, {}));
});

test('validateConfig rejects telegram config without global groupAllowFrom', () => {
  assert.throws(() => validateConfig({
    channel: {
      telegram: {
        bindings: { dm: {}, group: {}, topic: {} }
      }
    },
    agents
  }, { TELEGRAM_BOT_TOKEN: 'x' }));
});

test('resolveConfig merges system defaults into channel.telegram and normalizes bindings', () => {
  const resolved = resolveConfig(
    {
      channel: {
        telegram: {
          groupAllowFrom: ['1'],
          network: { proxy: 'http://127.0.0.1:7890' },
          streaming: true,
          requireMention: { group: true, topic: true },
          groups: { '-100123': { requireMention: false, groupAllowFrom: ['2'] } },
          topics: { '-100123:42': { requireMention: true, groupAllowFrom: ['3'] } },
          bindings: { dm: { '1': { instanceId: 'codex_cc' } }, group: {}, topic: {} }
        }
      },
      agents
    },
    { runtime: { mode: 'polling' } },
    { TELEGRAM_BOT_TOKEN: 'x' },
    { configDir: '/tmp' }
  );
  assert.equal(resolved.runtime.mode, 'polling');
  assert.equal(resolved.telegram.network.proxy, 'http://127.0.0.1:7890');
  assert.equal(resolved.telegram.streaming, true);
  assert.equal(resolved.telegram.requireMention.group, true);
  assert.equal(resolved.telegram.groups['-100123'].requireMention, false);
  assert.deepEqual(resolved.telegram.groupAllowFrom, ['1']);
  assert.deepEqual(resolved.telegram.groups['-100123'].groupAllowFrom, ['2']);
  assert.equal(resolved.telegram.topics['-100123:42'].requireMention, true);
  assert.deepEqual(resolved.telegram.topics['-100123:42'].groupAllowFrom, ['3']);
  assert.equal(resolved.channel.telegram.groupAllowFrom[0], '1');
  assert.deepEqual(resolved.bindings.telegram.dm, { '1': { instanceId: 'codex_cc' } });
  assert.deepEqual(resolved.bindings.telegram.accounts, {});
  assert.equal(resolved.agents.instances.codex_cc.providerId, 'codex');
});

test('resolveConfig normalizes provider and instance ACP model overrides', () => {
  const resolved = resolveConfig(
    {
      channel: {
        telegram: {
          groupAllowFrom: ['1'],
          bindings: { dm: { '1': { instanceId: 'codex_cc' } }, group: {}, topic: {} }
        }
      },
      agents: {
        providers: {
          codex: { driver: 'acpx', agent: 'codex', model: 'gpt-5.4[medium]' }
        },
        instances: {
          codex_cc: { providerId: 'codex', cwd: '/tmp' },
          codex_frontier: { providerId: 'codex', cwd: '/tmp', model: ' gpt-5.5[medium] ' }
        }
      }
    },
    null,
    { TELEGRAM_BOT_TOKEN: 'x' },
    { configDir: '/tmp' }
  );

  assert.equal(resolved.agents.providers.codex.model, 'gpt-5.4[medium]');
  assert.equal(resolved.agents.instances.codex_cc.model, 'gpt-5.4[medium]');
  assert.equal(resolved.agents.instances.codex_frontier.model, 'gpt-5.5[medium]');
});

test('resolveConfig lets channel.telegram override legacy telegram config', () => {
  const resolved = resolveConfig(
    {
      telegram: { allowedUserIds: [9], network: { proxy: 'http://legacy-proxy' } },
      channel: {
        telegram: {
          groupAllowFrom: ['1'],
          network: { proxy: 'http://new-proxy' },
          bindings: { dm: {}, group: {}, topic: {} }
        }
      },
      bindings: { telegram: { dm: { legacy: { instanceId: 'old' } }, group: {}, topic: {} } },
      agents
    },
    null,
    { TELEGRAM_BOT_TOKEN: 'x' },
    { configDir: '/tmp' }
  );

  assert.deepEqual(resolved.channel.telegram.groupAllowFrom, ['1']);
  assert.equal(resolved.telegram.network.proxy, 'http://new-proxy');
  assert.deepEqual(resolved.bindings.telegram.dm, { legacy: { instanceId: 'old' } });
});

test('resolveConfig normalizes telegram multi-account config and strips inline secrets from runtime config', () => {
  const resolved = resolveConfig(
    {
      channel: {
        telegram: {
          groupAllowFrom: ['1'],
          streaming: true,
          requireMention: { group: true, topic: false },
          network: { proxy: 'http://127.0.0.1:7890' },
          accounts: {
            '8641929320': {
              botToken: '8641929320:secret',
              streaming: false,
              groups: { '-100123': { requireMention: false } },
              bindings: { dm: { '1': { instanceId: 'codex_cc' } }, group: {}, topic: {} }
            }
          }
        }
      },
      agents
    },
    null,
    {},
    { configDir: '/tmp' }
  );

  assert.equal(resolved.telegram.streaming, true);
  assert.equal(resolved.telegram.accounts['8641929320'].streaming, false);
  assert.equal(resolved.telegram.accounts['8641929320'].requireMention.group, true);
  assert.equal(resolved.telegram.accounts['8641929320'].groups['-100123'].requireMention, false);
  assert.equal(resolved.telegram.accounts['8641929320'].botToken, undefined);
  assert.equal(resolved.channel.telegram.accounts['8641929320'].botToken, undefined);
  assert.equal(resolved.secrets.telegramAccounts['8641929320'].botToken, '8641929320:secret');
  assert.deepEqual(resolved.bindings.telegram.accounts['8641929320'].dm, { '1': { instanceId: 'codex_cc' } });
});

test('validateConfig accepts minimal user config in channel.feishu shape', () => {
  const config = {
    channel: {
      feishu: {
        enabled: true,
        groupAllowFrom: ['ou_123'],
        accounts: {
          appid: {
            appSecret: 'secret',
            bindings: { dm: { ou_123: { instanceId: 'codex_cc' } }, group: {} }
          }
        }
      }
    },
    agents
  };
  assert.equal(validateConfig(config, {}), true);
});

test('validateConfig accepts feishu bootstrap admin config without bindings', () => {
  const config = {
    channel: {
      feishu: {
        enabled: true,
        adminUserIds: ['ou_admin'],
        groupAllowFrom: ['ou_admin'],
        accounts: {
          default: {
            appId: 'cli_xxx',
            appSecret: 'secret',
            bindings: { dm: {}, group: {} }
          }
        }
      }
    },
    agents
  };
  assert.equal(validateConfig(config, {}), true);
});

test('validateConfig accepts explicit multi-account feishu shape', () => {
  const config = {
    channel: {
      feishu: {
        enabled: true,
        groupAllowFrom: ['ou_owner'],
        accounts: {
          'main-id': {
            appSecret: 'main-secret',
            bindings: { dm: { ou_main: { instanceId: 'codex_cc' } }, group: {} }
          },
          'review-id': {
            appSecret: 'review-secret',
            bindings: { dm: { ou_review: { instanceId: 'codex_cc' } }, group: {} }
          }
        }
      }
    },
    agents
  };

  assert.equal(validateConfig(config, {}), true);
});

test('validateConfig rejects missing feishu secrets when feishu is configured', () => {
  assert.throws(() => validateConfig({
    channel: {
      feishu: {
        enabled: true,
        bindings: { dm: { ou_123: { instanceId: 'codex_cc' } }, group: {} }
      }
    },
    agents
  }, {}));
});

test('resolveConfig normalizes channel.feishu and env secrets', () => {
  const resolved = resolveConfig(
    {
      channel: {
        feishu: {
          enabled: true,
          requireMention: false,
          network: { useSystemProxy: false },
          groupAllowFrom: ['ou_123'],
          accounts: {
            appid: {
              appSecret: 'secret',
              bindings: { dm: { ou_123: { instanceId: 'codex_cc' } }, group: { oc_456: { instanceId: 'codex_cc' } } }
            }
          }
        }
      },
      agents
    },
    null,
    {},
    { configDir: '/tmp' }
  );

  assert.equal(resolved.channel.feishu.enabled, true);
  assert.equal(resolved.feishu.requireMention, false);
  assert.equal(resolved.feishu.network.useSystemProxy, false);
  assert.deepEqual(resolved.bindings.feishu.accounts.appid.dm, { ou_123: { instanceId: 'codex_cc' } });
  assert.equal(resolved.secrets.feishuAccounts.appid.appId, 'appid');
  assert.equal(resolved.secrets.feishuAccounts.appid.appSecret, 'secret');
});

test('validateConfig accepts minimal user config in channel.wechat shape', () => {
  const config = {
    channel: {
      wechat: {
        enabled: true,
        accounts: [
          {
            accountId: 'bot@im.bot',
            bindings: { dm: { wxid_alice: { instanceId: 'codex_cc' } } }
          }
        ]
      }
    },
    agents
  };
  assert.equal(validateConfig(config, {}), true);
});

test('resolveConfig normalizes channel.wechat native settings', () => {
  const resolved = resolveConfig(
    {
      channel: {
        wechat: {
          enabled: true,
          apiBaseUrl: 'https://api-wechat.example',
          cdnBaseUrl: 'https://cdn-wechat.example',
          botType: '5',
          loginTimeoutMs: 123000,
          longPollTimeoutMs: 33000,
          accounts: [
            {
              accountId: 'bot@im.bot',
              bindings: { dm: { wxid_alice: { instanceId: 'codex_cc' } } }
            }
          ]
        }
      },
      agents
    },
    null,
    {},
    { configDir: '/tmp' }
  );

  assert.equal(resolved.channel.wechat.enabled, true);
  assert.equal(resolved.wechat.apiBaseUrl, 'https://api-wechat.example');
  assert.equal(resolved.wechat.cdnBaseUrl, 'https://cdn-wechat.example');
  assert.equal(resolved.wechat.botType, '5');
  assert.equal(resolved.wechat.loginTimeoutMs, 123000);
  assert.equal(resolved.wechat.longPollTimeoutMs, 33000);
  assert.deepEqual(resolved.bindings.wechat.accounts['bot@im.bot'].dm, { wxid_alice: { instanceId: 'codex_cc' } });
  assert.equal(resolved.wechat.accounts['bot@im.bot'].accountId, 'bot@im.bot');
});
