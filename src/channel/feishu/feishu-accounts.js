import { buildResolvedFeishuAccounts } from '../../config/channel-config.js';

function normalizeOpenIdList(values = []) {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeGroupConfig(groupConfig = {}) {
  const raw = groupConfig.groupAllowFrom ?? groupConfig.allowFrom;
  const result = { ...groupConfig };
  if (raw !== undefined) {
    result.groupAllowFrom = normalizeOpenIdList(raw);
  }
  delete result.allowFrom;
  return result;
}

export function listResolvedFeishuAccounts(config = {}, secrets = {}) {
  const accounts = buildResolvedFeishuAccounts(config);
  const secretAccounts = {
    default: {
      appId: secrets.feishuAppId ?? secrets.appId,
      appSecret: secrets.feishuAppSecret ?? secrets.appSecret
    },
    ...(secrets.feishuAccounts ?? {})
  };
  return Object.entries(accounts).map(([accountId, accountConfig]) => {
    const mergedConfig = {
      requireMention: true,
      groupAllowFrom: [],
      network: { useSystemProxy: false },
      streaming: false,
      footer: { elapsed: false, status: false },
      groups: {},
      ...accountConfig
    };

    return {
      accountId,
      config: {
        ...mergedConfig,
        groupAllowFrom: normalizeOpenIdList(mergedConfig.groupAllowFrom),
        groups: Object.fromEntries(
          Object.entries(mergedConfig.groups ?? {}).map(([groupId, groupConfig]) => [groupId, normalizeGroupConfig(groupConfig)])
        )
      },
      secrets: {
        appId: accountConfig.appId ?? secretAccounts[accountId]?.appId,
        appSecret: accountConfig.appSecret ?? secretAccounts[accountId]?.appSecret
      }
    };
  });
}

export function getResolvedFeishuAccount(config = {}, secrets = {}, accountId = 'default') {
  return listResolvedFeishuAccounts(config, secrets).find((account) => account.accountId === accountId) ?? null;
}

export function getEnabledFeishuAccounts(config = {}, secrets = {}) {
  return listResolvedFeishuAccounts(config, secrets).filter((account) =>
    account.config.enabled !== false && Boolean(account.secrets.appId && account.secrets.appSecret)
  );
}
