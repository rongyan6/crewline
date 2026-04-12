import os from 'node:os';
import path from 'node:path';
import { buildResolvedChannelConfig } from './channel-config.js';

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolvePath(baseDir, value) {
  const expanded = expandHome(value);
  if (!expanded) return expanded;
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(baseDir, expanded);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

function stripTelegramAccountSecrets(accountConfig = {}) {
  const next = { ...accountConfig };
  delete next.botToken;
  delete next.token;
  return next;
}

function defaultSystemConfig() {
  return {
    runtime: {
      mode: 'polling',
      dataDir: '~/.crewline',
      timezone: 'Asia/Shanghai',
      acpxTurnTimeoutMs: 600000,
      gracefulShutdownMs: 10000,
      hotReload: false
    },
    telegram: {
      polling: {
        enabled: true,
        timeoutSeconds: 30
      },
      webhook: {
        enabled: false,
        baseUrl: '',
        path: '/telegram/webhook'
      },
      network: {
        proxy: null,
        autoSelectFamily: true,
        dangerouslyAllowPrivateNetwork: false
      }
    },
    feishu: {
      enabled: false,
      network: {
        useSystemProxy: false
      }
    },
    wechat: {
      enabled: false,
      apiBaseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      botType: '3',
      loginTimeoutMs: 480000,
      longPollTimeoutMs: 35000
    },
    session: {
      sticky: true,
      resumeOnStartup: true,
      idleTtlMinutes: 240,
      maxTurnsPerSession: 200
    },
    logging: {
      level: 'info',
      dir: '~/.crewline/logs',
      stdout: true,
      redact: ['telegram.botToken']
    }
  };
}

function normalizeAgents(agents = {}) {
  const providers = {};
  for (const [id, config] of Object.entries(agents.providers ?? {})) {
    providers[id] = {
      driver: config.driver ?? 'acpx',
      agent: config.agent ?? id
    };
  }
  const instances = {};
  for (const [id, config] of Object.entries(agents.instances ?? {})) {
    instances[id] = {
      providerId: config.providerId,
      cwd: config.cwd,
      sessionNamePrefix: config.sessionNamePrefix ?? `crewline-${id}`,
      approvalMode: config.approvalMode ?? 'default'
    };
  }
  return {
    providers,
    instances
  };
}

export function resolveConfig(userConfig, systemConfig, env, { configDir } = {}) {
  const baseDir = configDir ?? process.cwd();
  const merged = deepMerge(deepMerge(defaultSystemConfig(), systemConfig ?? {}), userConfig ?? {});
  const channel = buildResolvedChannelConfig(merged);
  const telegram = {
    ...channel.telegram,
    accounts: Object.fromEntries(
      Object.entries(channel.telegram.accounts ?? {}).map(([accountId, accountConfig]) => [accountId, {
        ...stripTelegramAccountSecrets(accountConfig),
        enabled: accountConfig.enabled !== false,
        accountId,
        botId: accountConfig.botId ?? accountId
      }])
    ),
    network: {
      ...channel.telegram.network,
      proxy: channel.telegram.network?.proxy ?? null,
      autoSelectFamily: channel.telegram.network?.autoSelectFamily ?? true,
      dangerouslyAllowPrivateNetwork: channel.telegram.network?.dangerouslyAllowPrivateNetwork ?? false
    }
  };
  const feishu = {
    ...channel.feishu,
    enabled: channel.feishu.enabled !== false,
    accounts: Object.fromEntries(
      Object.entries(channel.feishu.accounts ?? {}).map(([accountId, accountConfig]) => [accountId, {
        ...accountConfig,
        enabled: accountConfig.enabled !== false
      }])
    )
  };
  const wechat = {
    ...channel.wechat,
    enabled: channel.wechat.enabled === true,
    apiBaseUrl: channel.wechat.apiBaseUrl ?? 'https://ilinkai.weixin.qq.com',
    cdnBaseUrl: channel.wechat.cdnBaseUrl ?? 'https://novac2c.cdn.weixin.qq.com/c2c',
    botType: String(channel.wechat.botType ?? '3'),
    loginTimeoutMs: Number(channel.wechat.loginTimeoutMs ?? 480000),
    longPollTimeoutMs: Number(channel.wechat.longPollTimeoutMs ?? 35000),
    accounts: Object.fromEntries(
      Object.entries(channel.wechat.accounts ?? {}).map(([accountId, accountConfig]) => [accountId, {
        ...accountConfig,
        enabled: accountConfig.enabled !== false,
        accountId
      }])
    )
  };

  const feishuAccountSecrets = Object.fromEntries(
    Object.entries(feishu.accounts ?? {}).map(([accountId, accountConfig]) => [accountId, {
      appId: accountConfig.appId ?? accountId,
      appSecret: accountConfig.appSecret ?? null
    }])
  );
  const telegramAccountSecrets = Object.fromEntries(
    Object.entries(channel.telegram.accounts ?? {}).map(([accountId, accountConfig]) => [accountId, {
      botToken: accountConfig.botToken ?? accountConfig.token ?? null
    }])
  );

  return {
    ...merged,
    runtime: {
      ...merged.runtime,
      dataDir: resolvePath(baseDir, merged.runtime.dataDir)
    },
    channel: {
      ...(merged.channel ?? {}),
      telegram: {
        ...telegram,
        bindings: channel.telegram.bindings
      },
      feishu: {
        ...feishu,
        bindings: channel.feishu.bindings
      },
      wechat: {
        ...wechat,
        bindings: channel.wechat.bindings
      }
    },
    telegram,
    feishu,
    wechat,
    agents: normalizeAgents(merged.agents),
    bindings: {
      telegram: channel.telegram.bindings,
      feishu: {
        ...channel.feishu.bindings,
        accounts: Object.fromEntries(
          Object.entries(feishu.accounts ?? {}).map(([accountId, accountConfig]) => [accountId, accountConfig.bindings ?? { dm: {}, group: {} }])
        )
      },
      wechat: {
        ...channel.wechat.bindings,
        accounts: Object.fromEntries(
          Object.entries(wechat.accounts ?? {}).map(([accountId, accountConfig]) => [accountId, accountConfig.bindings ?? { dm: {} }])
        )
      }
    },
    logging: {
      ...merged.logging,
      dir: resolvePath(baseDir, merged.logging.dir)
    },
    secrets: {
      telegramBotToken: null,
      telegramAccounts: telegramAccountSecrets,
      feishuAppId: null,
      feishuAppSecret: null,
      feishuAccounts: feishuAccountSecrets
    }
  };
}
