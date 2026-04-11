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

function normalizeTelegramBindings(bindings = {}) {
  return {
    dm: bindings.dm ?? {},
    group: bindings.group ?? {},
    topic: bindings.topic ?? {}
  };
}

function normalizeFeishuBindings(bindings = {}) {
  return {
    dm: bindings.dm ?? {},
    group: bindings.group ?? {}
  };
}

function normalizeWechatBindings(bindings = {}) {
  return {
    dm: bindings.dm ?? {}
  };
}

function stripTelegramAccountInternals(config = {}) {
  const next = { ...config };
  delete next.bindings;
  delete next.accounts;
  delete next.accountId;
  delete next.botId;
  delete next.id;
  delete next.name;
  delete next.botToken;
  return next;
}

function stripWechatAccountInternals(config = {}) {
  const next = { ...config };
  delete next.bindings;
  delete next.accounts;
  delete next.accountId;
  delete next.id;
  delete next.name;
  return next;
}

function stripFeishuAccountInternals(config = {}) {
  const next = { ...config };
  delete next.bindings;
  delete next.accounts;
  delete next.appId;
  delete next.appSecret;
  delete next.id;
  delete next.name;
  delete next.credentials;
  delete next.defaults;
  delete next.domain;
  delete next.connectionMode;
  return next;
}

function listFeishuAccountEntries(rawAccounts) {
  if (Array.isArray(rawAccounts)) {
    return rawAccounts.map((account, index) => {
      const explicitId = account?.id ?? account?.name ?? null;
      const accountId = typeof explicitId === 'string' && explicitId.trim()
        ? explicitId.trim()
        : (rawAccounts.length === 1 ? 'default' : `account_${index + 1}`);
      return [accountId, account ?? {}];
    });
  }
  if (rawAccounts && typeof rawAccounts === 'object') {
    return Object.entries(rawAccounts);
  }
  return [];
}

function listTelegramAccountEntries(rawAccounts) {
  if (Array.isArray(rawAccounts)) {
    return rawAccounts.map((account, index) => {
      const explicitId = account?.botId ?? account?.accountId ?? account?.id ?? account?.name ?? null;
      const accountId = typeof explicitId === 'string' && explicitId.trim()
        ? explicitId.trim()
        : (rawAccounts.length === 1 ? 'default' : `account_${index + 1}`);
      return [accountId, account ?? {}];
    });
  }
  if (rawAccounts && typeof rawAccounts === 'object') {
    return Object.entries(rawAccounts);
  }
  return [];
}

export function getUserTelegramConfig(config = {}) {
  const direct = config.accounts || config.bindings || config.allowedUserIds || config.groupAllowFrom ? config : {};
  return deepMerge(
    deepMerge(config.telegram ?? direct, config.channels?.telegram ?? {}),
    config.channel?.telegram ?? {}
  );
}

export function getUserFeishuConfig(config = {}) {
  const direct = config.accounts || config.bindings || config.enabled !== undefined
    ? config
    : {};
  return deepMerge(
    deepMerge(config.feishu ?? direct, config.channels?.feishu ?? {}),
    config.channel?.feishu ?? {}
  );
}

export function getUserWechatConfig(config = {}) {
  const direct = config.apiBaseUrl || config.bindings || config.accounts || config.enabled !== undefined
    ? config
    : {};
  return deepMerge(
    deepMerge(config.wechat ?? direct, config.channels?.wechat ?? {}),
    config.channel?.wechat ?? {}
  );
}

export function getUserTelegramBindings(config = {}) {
  const legacyBindings = config.bindings?.telegram ?? (config.dm || config.group || config.topic ? config : {});
  const channelBindings = deepMerge(config.channels?.telegram?.bindings ?? {}, config.channel?.telegram?.bindings ?? {});
  const telegram = getUserTelegramConfig(config);
  const accountBindings = Object.fromEntries(
    listTelegramAccountEntries(telegram.accounts).map(([accountId, account]) => [
      accountId,
      normalizeTelegramBindings(account?.bindings ?? {})
    ])
  );
  return {
    ...normalizeTelegramBindings(deepMerge(legacyBindings, channelBindings)),
    accounts: accountBindings
  };
}

export function getUserFeishuBindings(config = {}) {
  return normalizeFeishuBindings(config.channel?.feishu?.bindings ?? config.channels?.feishu?.bindings ?? {});
}

export function getUserWechatBindings(config = {}) {
  const legacyBindings = config.bindings?.wechat ?? (config.dm && !config.group && !config.topic ? config : {});
  const channelBindings = deepMerge(config.channels?.wechat?.bindings ?? {}, config.channel?.wechat?.bindings ?? {});
  return normalizeWechatBindings(deepMerge(legacyBindings, channelBindings));
}

export function getUserWechatAccounts(config = {}) {
  const wechat = getUserWechatConfig(config);
  if (Array.isArray(wechat.accounts)) return wechat.accounts;
  if (wechat.accounts && typeof wechat.accounts === 'object') {
    return Object.entries(wechat.accounts).map(([accountId, account]) => ({
      accountId,
      ...(account ?? {})
    }));
  }
  return [];
}

export function getUserTelegramAccounts(config = {}) {
  const telegram = getUserTelegramConfig(config);
  return telegram.accounts ?? [];
}

export function hasAnyTelegramBinding(bindings = {}) {
  return Object.keys(bindings.dm ?? {}).length > 0 ||
    Object.keys(bindings.group ?? {}).length > 0 ||
    Object.keys(bindings.topic ?? {}).length > 0 ||
    Object.values(bindings.accounts ?? {}).some((accountBindings) => (
      Object.keys(accountBindings?.dm ?? {}).length > 0 ||
      Object.keys(accountBindings?.group ?? {}).length > 0 ||
      Object.keys(accountBindings?.topic ?? {}).length > 0
    ));
}

export function hasAnyFeishuBinding(bindings = {}) {
  return Object.keys(bindings.dm ?? {}).length > 0 ||
    Object.keys(bindings.group ?? {}).length > 0;
}

export function hasAnyWechatBinding(bindings = {}) {
  return Object.keys(bindings.dm ?? {}).length > 0;
}

export function getUserFeishuAccounts(config = {}) {
  const feishu = getUserFeishuConfig(config);
  return feishu.accounts ?? [];
}

export function isTelegramConfigured(config = {}) {
  const telegram = getUserTelegramConfig(config);
  const bindings = getUserTelegramBindings(config);
  const accounts = getUserTelegramAccounts(config);
  return Boolean(
    telegram.groupAllowFrom?.length ||
    telegram.allowedUserIds?.length ||
    telegram.adminUserIds?.length ||
    hasAnyTelegramBinding(bindings) ||
    (Array.isArray(accounts) ? accounts.length > 0 : Object.keys(accounts ?? {}).length > 0)
  );
}

export function isFeishuConfigured(config = {}) {
  const feishu = getUserFeishuConfig(config);
  const accounts = getUserFeishuAccounts(config);
  return feishu.enabled !== false && Boolean(
    (Array.isArray(accounts) ? accounts.length > 0 : Object.keys(accounts ?? {}).length > 0) ||
    config.channel?.feishu ||
    config.feishu
  );
}

export function isWechatConfigured(config = {}) {
  const wechat = getUserWechatConfig(config);
  const bindings = getUserWechatBindings(config);
  const accounts = getUserWechatAccounts(config);
  return wechat.enabled !== false && Boolean(
    hasAnyWechatBinding(bindings) ||
    accounts.length > 0 ||
    config.channel?.wechat ||
    config.wechat
  );
}

export function buildResolvedWechatAccounts(config = {}) {
  const wechat = getUserWechatConfig(config);
  const baseConfig = {
    enabled: wechat.enabled !== false,
    ...stripWechatAccountInternals(wechat)
  };
  const accounts = {};
  for (const account of getUserWechatAccounts(config)) {
    const explicitId = account?.accountId ?? account?.id ?? account?.name ?? null;
    if (typeof explicitId !== 'string' || !explicitId.trim()) continue;
    const accountId = explicitId.trim();
    accounts[accountId] = {
      ...deepMerge(baseConfig, stripWechatAccountInternals(account ?? {})),
      accountId,
      bindings: normalizeWechatBindings(account?.bindings ?? {})
    };
  }
  return accounts;
}

export function buildResolvedTelegramAccounts(config = {}) {
  const telegram = getUserTelegramConfig(config);
  const topLevelPolicy = {
    ...stripTelegramAccountInternals(telegram)
  };
  const accounts = {};

  for (const [accountId, override] of listTelegramAccountEntries(getUserTelegramAccounts(config))) {
    const merged = deepMerge(topLevelPolicy, stripTelegramAccountInternals(override ?? {}));
    accounts[accountId] = {
      ...merged,
      accountId,
      botId: accountId,
      botToken: override?.botToken ?? override?.token ?? null,
      bindings: normalizeTelegramBindings(override?.bindings ?? {}),
      groups: deepMerge(telegram.groups ?? {}, override?.groups ?? {}),
      topics: deepMerge(telegram.topics ?? {}, override?.topics ?? {})
    };
  }

  return accounts;
}

export function buildResolvedFeishuAccounts(config = {}) {
  const feishu = getUserFeishuConfig(config);
  const topLevelPolicy = {
    enabled: feishu.enabled !== false,
    ...stripFeishuAccountInternals(feishu)
  };

  const explicitAccounts = getUserFeishuAccounts(config);
  const accountEntries = listFeishuAccountEntries(explicitAccounts);
  const accounts = {};

  for (const [accountId, override] of accountEntries) {
    const merged = deepMerge(stripFeishuAccountInternals(override ?? {}), topLevelPolicy);
    accounts[accountId] = {
      ...merged,
      appId: override?.appId ?? accountId,
      appSecret: override?.appSecret ?? null,
      bindings: normalizeFeishuBindings(override?.bindings ?? {})
    };
  }

  return accounts;
}

export function buildResolvedChannelConfig(config = {}) {
  const telegram = { ...getUserTelegramConfig(config) };
  delete telegram.bindings;
  delete telegram.accounts;
  delete telegram.botToken;
  delete telegram.token;
  const telegramAccounts = buildResolvedTelegramAccounts(config);

  const feishu = {
    enabled: true,
    ...getUserFeishuConfig(config)
  };
  delete feishu.bindings;
  delete feishu.accounts;
  const feishuAccounts = buildResolvedFeishuAccounts(config);
  const wechat = {
    enabled: false,
    apiBaseUrl: 'https://ilinkai.weixin.qq.com',
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    botType: '3',
    loginTimeoutMs: 480000,
    longPollTimeoutMs: 35000,
    ...getUserWechatConfig(config)
  };
  delete wechat.bindings;
  delete wechat.accounts;
  const wechatAccounts = buildResolvedWechatAccounts(config);

  return {
    telegram: {
      ...telegram,
      bindings: getUserTelegramBindings(config),
      accounts: telegramAccounts
    },
    feishu: {
      ...feishu,
      bindings: getUserFeishuBindings(config),
      accounts: feishuAccounts
    },
    wechat: {
      ...wechat,
      bindings: getUserWechatBindings(config),
      accounts: wechatAccounts
    }
  };
}
