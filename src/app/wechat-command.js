import { loginWechatChannel } from '../channel/wechat/wechat-bridge.js';
import { getServiceStatus, restartService } from './service-manager.js';
import { loadResolvedRuntimeConfig, persistUserConfig } from './runtime-config.js';

function pickDefaultInstanceId(userConfig = {}) {
  const instanceIds = Object.keys(userConfig?.agents?.instances ?? {});
  if (instanceIds.includes('codex_cc')) return 'codex_cc';
  return instanceIds[0] ?? null;
}

function normalizeWechatAccountsObject(channelWechat = {}) {
  if (channelWechat.accounts && !Array.isArray(channelWechat.accounts) && typeof channelWechat.accounts === 'object') {
    return { ...channelWechat.accounts };
  }
  if (Array.isArray(channelWechat.accounts)) {
    return Object.fromEntries(
      channelWechat.accounts
        .filter((entry) => typeof entry?.accountId === 'string' && entry.accountId.trim())
        .map((entry) => [entry.accountId.trim(), { ...(entry ?? {}), accountId: undefined }])
    );
  }
  return {};
}

export function applyWechatAutoBinding(userConfig = {}, { accountId, userId }) {
  if (!userId) return userConfig;
  const next = structuredClone(userConfig);
  next.channel ??= {};
  next.channel.wechat ??= {};
  next.channel.wechat.enabled = true;
  next.channel.wechat.accounts = normalizeWechatAccountsObject(next.channel.wechat);

  const placeholderKeys = ['pending-wechat-user-id', '__pending_wechat_user_id__', 'wechat-user-id'];
  let accountEntry = next.channel.wechat.accounts[accountId] ?? null;
  if (!accountEntry) {
    accountEntry = { bindings: { dm: {} } };
    next.channel.wechat.accounts[accountId] = accountEntry;
  }
  accountEntry.bindings ??= {};
  accountEntry.bindings.dm ??= {};
  const dmBindings = accountEntry.bindings.dm;
  if (!dmBindings[userId]?.instanceId) {
    for (const key of placeholderKeys) {
      if (dmBindings[key]) {
        dmBindings[userId] = dmBindings[key];
        delete dmBindings[key];
        break;
      }
    }
  }
  if (!dmBindings[userId]?.instanceId && Object.keys(dmBindings).length === 0) {
    const instanceId = pickDefaultInstanceId(next);
    if (instanceId) {
      dmBindings[userId] = { instanceId };
    }
  }

  // Migrate legacy top-level bindings into the first logged-in account on write-back.
  if (next.channel.wechat.bindings?.dm) {
    for (const [key, value] of Object.entries(next.channel.wechat.bindings.dm)) {
      if (!dmBindings[key]) {
        dmBindings[key] = value;
      }
    }
    for (const key of placeholderKeys) {
      delete dmBindings[key];
    }
    delete next.channel.wechat.bindings;
  }

  return next;
}

export async function persistWechatAutoBinding({ configPath, userConfig, accountId, userId }) {
  const next = applyWechatAutoBinding(userConfig, { accountId, userId });
  await persistUserConfig(configPath, next);
  return next;
}

export async function runWechatLoginCommand() {
  const { config, configPath, userConfig } = await loadResolvedRuntimeConfig();
  const result = await loginWechatChannel({
    config: config.wechat ?? config.channel?.wechat ?? {},
    dataDir: config.runtime?.dataDir
  });
  let bindingUpdated = false;
  if (result.ok && result.userId) {
    const nextConfig = await persistWechatAutoBinding({
      configPath,
      userConfig,
      accountId: result.accountId,
      userId: result.userId
    });
    bindingUpdated = JSON.stringify(nextConfig?.channel?.wechat?.accounts ?? {}) !==
      JSON.stringify(userConfig?.channel?.wechat?.accounts ?? {});
  }
  const status = await getServiceStatus().catch(() => ({ running: false }));
  let serviceReloaded = false;
  if (result.ok && status?.running) {
    const restarted = await restartService().catch(() => null);
    serviceReloaded = Boolean(restarted?.started?.started);
  }
  return {
    ...result,
    bindingUpdated,
    serviceReloaded
  };
}
