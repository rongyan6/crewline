import {
  buildResolvedTelegramAccounts,
  buildResolvedFeishuAccounts,
  buildResolvedWechatAccounts,
  getUserFeishuConfig,
  getUserFeishuBindings,
  getUserTelegramAccounts,
  getUserTelegramBindings,
  getUserTelegramConfig,
  getUserWechatAccounts,
  getUserWechatBindings,
  hasAnyFeishuBinding,
  hasAnyTelegramBinding,
  hasAnyWechatBinding,
  isFeishuConfigured,
  isTelegramConfigured,
  isWechatConfigured
} from './channel-config.js';
import { CrewlineError } from '../shared/errors/error-envelope.js';
import { ErrorCodes } from '../shared/errors/error-codes.js';

export function validateConfig(config, env) {
  const telegram = getUserTelegramConfig(config);
  const telegramBindings = getUserTelegramBindings(config);
  const feishuBindings = getUserFeishuBindings(config);
  const wechatBindings = getUserWechatBindings(config);
  const telegramEnabled = isTelegramConfigured(config);
  const feishuEnabled = isFeishuConfigured(config);
  const wechatEnabled = isWechatConfigured(config);
  const feishuAccounts = buildResolvedFeishuAccounts(config);
  const wechatAccounts = buildResolvedWechatAccounts(config);
  const telegramAccounts = buildResolvedTelegramAccounts(config);
  const telegramAdminUserIds = telegram.adminUserIds ?? [];

  if (!config?.agents || (!telegramEnabled && !feishuEnabled && !wechatEnabled)) {
    throw new CrewlineError({
      code: ErrorCodes.CONFIG_INVALID,
      layer: 'config',
      recoverable: false,
      message: 'Missing required user config sections'
    });
  }

  if (!config.agents?.providers || !config.agents?.instances) {
    throw new CrewlineError({
      code: ErrorCodes.CONFIG_INVALID,
      layer: 'config',
      recoverable: false,
      message: 'agents.providers and agents.instances are required'
    });
  }

  if (Object.keys(config.agents.providers).length === 0 || Object.keys(config.agents.instances).length === 0) {
    throw new CrewlineError({
      code: ErrorCodes.CONFIG_INVALID,
      layer: 'config',
      recoverable: false,
      message: 'agents.providers and agents.instances must not be empty'
    });
  }

  if (telegramEnabled) {
    const globalGroupAllowFrom = telegram.groupAllowFrom ?? telegram.allowedUserIds;
    const rawTelegramAccounts = getUserTelegramAccounts(config);
    const hasGroupOrTopicBinding = Object.keys(telegramBindings.group ?? {}).length > 0 ||
      Object.keys(telegramBindings.topic ?? {}).length > 0 ||
      Object.values(telegramBindings.accounts ?? {}).some((accountBindings) =>
        Object.keys(accountBindings?.group ?? {}).length > 0 || Object.keys(accountBindings?.topic ?? {}).length > 0
      );
    if (hasGroupOrTopicBinding && (!Array.isArray(globalGroupAllowFrom) || globalGroupAllowFrom.length === 0)) {
      throw new CrewlineError({
        code: ErrorCodes.CONFIG_INVALID,
        layer: 'config',
        recoverable: false,
        message: 'channel.telegram.groupAllowFrom is required'
      });
    }
    if (!telegramBindings || typeof telegramBindings !== 'object') {
      throw new CrewlineError({
        code: ErrorCodes.CONFIG_INVALID,
        layer: 'config',
        recoverable: false,
        message: 'channel.telegram.bindings is invalid'
      });
    }
    if (Array.isArray(rawTelegramAccounts)) {
      const seenTelegramAccountIds = new Set();
      for (const account of rawTelegramAccounts) {
        const accountId = account?.botId ?? account?.accountId ?? account?.id ?? account?.name ?? null;
        if (typeof accountId !== 'string' || !accountId.trim()) {
          throw new CrewlineError({
            code: ErrorCodes.CONFIG_INVALID,
            layer: 'config',
            recoverable: false,
            message: 'channel.telegram.accounts.<botId> is required'
          });
        }
        if (seenTelegramAccountIds.has(accountId.trim())) {
          throw new CrewlineError({
            code: ErrorCodes.CONFIG_INVALID,
            layer: 'config',
            recoverable: false,
            message: `Duplicate Telegram botId: ${accountId.trim()}`
          });
        }
        seenTelegramAccountIds.add(accountId.trim());
      }
    }
    const configuredTelegramAccounts = Object.entries(telegramAccounts);
    const hasExplicitAccounts = configuredTelegramAccounts.length > 0;
    for (const [accountId, account] of configuredTelegramAccounts) {
      const token = account.botToken ?? account.token ?? null;
      if (!token) {
        throw new CrewlineError({
          code: ErrorCodes.SECRET_MISSING,
          layer: 'config',
          recoverable: false,
          message: `Missing Telegram botToken for account '${accountId}'`
        });
      }
      const tokenBotId = String(token).split(':', 1)[0]?.trim?.() ?? '';
      if (!/^\d+$/.test(tokenBotId)) {
        throw new CrewlineError({
          code: ErrorCodes.CONFIG_INVALID,
          layer: 'config',
          recoverable: false,
          message: `Invalid Telegram botToken for account '${accountId}'`
        });
      }
      if (tokenBotId !== accountId) {
        throw new CrewlineError({
          code: ErrorCodes.CONFIG_INVALID,
          layer: 'config',
          recoverable: false,
          message: `Telegram account key '${accountId}' must match botToken prefix '${tokenBotId}'`
        });
      }
    }
    if (hasExplicitAccounts) {
      const hasAnyTelegramAccountBinding = configuredTelegramAccounts.some(([, account]) =>
        hasAnyTelegramBinding(account.bindings)
      );
      if (!hasAnyTelegramAccountBinding && telegramAdminUserIds.length === 0) {
        throw new CrewlineError({
          code: ErrorCodes.CONFIG_INVALID,
          layer: 'config',
          recoverable: false,
          message: 'channel.telegram.accounts.<botId>.bindings.dm/group/topic is required'
        });
      }
    } else {
      throw new CrewlineError({
        code: ErrorCodes.SECRET_MISSING,
        layer: 'config',
        recoverable: false,
        message: 'Missing channel.telegram.accounts.<botId>.botToken'
      });
    }
  }

  if (feishuEnabled) {
    if (Object.keys(feishuAccounts).length === 0) {
      throw new CrewlineError({
        code: ErrorCodes.CONFIG_INVALID,
        layer: 'config',
        recoverable: false,
        message: 'channel.feishu.accounts must contain at least one account'
      });
    }
    const hasAnyFeishuCredentials = Object.values(feishuAccounts).some((account) =>
      account.enabled !== false &&
      Boolean(account.appId && account.appSecret)
    );
    if (!hasAnyFeishuCredentials) {
      throw new CrewlineError({
        code: ErrorCodes.SECRET_MISSING,
        layer: 'config',
        recoverable: false,
        message: 'Missing Feishu account appId/appSecret in channel.feishu.accounts'
      });
    }
    const globalFeishuAllowFrom = getUserFeishuConfig(config).groupAllowFrom ?? [];
    if (!Array.isArray(globalFeishuAllowFrom) || globalFeishuAllowFrom.length === 0) {
      throw new CrewlineError({
        code: ErrorCodes.CONFIG_INVALID,
        layer: 'config',
        recoverable: false,
        message: 'channel.feishu.groupAllowFrom is required'
      });
    }
    const hasAnyFeishuAccountBinding = Object.values(feishuAccounts).some((account) =>
      hasAnyFeishuBinding(account.bindings)
    );
    const feishuAdminUserIds = config?.channel?.feishu?.adminUserIds ?? [];
    if (!hasAnyFeishuAccountBinding && feishuAdminUserIds.length === 0) {
      throw new CrewlineError({
        code: ErrorCodes.CONFIG_INVALID,
        layer: 'config',
        recoverable: false,
        message: 'channel.feishu.accounts.<appId>.bindings.dm/group is required'
      });
    }
  }

  if (wechatEnabled) {
    if (!wechatBindings || typeof wechatBindings !== 'object') {
      throw new CrewlineError({
        code: ErrorCodes.CONFIG_INVALID,
        layer: 'config',
        recoverable: false,
        message: 'channel.wechat.bindings is invalid'
      });
    }
    if (!hasAnyWechatBinding(wechatBindings)) {
      const accountEntries = getUserWechatAccounts(config);
      if (accountEntries.length === 0) {
        throw new CrewlineError({
          code: ErrorCodes.CONFIG_INVALID,
          layer: 'config',
          recoverable: false,
          message: 'channel.wechat.bindings.dm is required'
        });
      }
      for (const account of accountEntries) {
        if (typeof account?.accountId !== 'string' || !account.accountId.trim()) {
          throw new CrewlineError({
            code: ErrorCodes.CONFIG_INVALID,
            layer: 'config',
            recoverable: false,
            message: 'channel.wechat.accounts.<accountId> is required'
          });
        }
      }
      const duplicateIds = new Set();
      for (const account of accountEntries) {
        const accountId = account.accountId.trim();
        if (duplicateIds.has(accountId)) {
          throw new CrewlineError({
            code: ErrorCodes.CONFIG_INVALID,
            layer: 'config',
            recoverable: false,
            message: `Duplicate WeChat accountId: ${accountId}`
          });
        }
        duplicateIds.add(accountId);
      }
      const hasAnyAccountBinding = Object.values(wechatAccounts).some((account) => hasAnyWechatBinding(account.bindings));
      if (!hasAnyAccountBinding) {
        throw new CrewlineError({
          code: ErrorCodes.CONFIG_INVALID,
          layer: 'config',
          recoverable: false,
          message: 'channel.wechat.accounts.<accountId>.bindings.dm is required'
        });
      }
    }
  }

  return true;
}
