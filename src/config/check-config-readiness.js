import fs from 'node:fs';
import {
  buildResolvedTelegramAccounts,
  buildResolvedFeishuAccounts,
  buildResolvedWechatAccounts,
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

export function getConfigReadiness(userConfig, env) {
  const issues = [];
  const suggestions = [];
  const telegram = getUserTelegramConfig(userConfig);
  const telegramBindings = getUserTelegramBindings(userConfig);
  const wechatBindings = getUserWechatBindings(userConfig);
  const telegramEnabled = isTelegramConfigured(userConfig);
  const feishuEnabled = isFeishuConfigured(userConfig);
  const wechatEnabled = isWechatConfigured(userConfig);
  const telegramAccounts = buildResolvedTelegramAccounts(userConfig);
  const feishuAccounts = buildResolvedFeishuAccounts(userConfig);
  const wechatAccounts = buildResolvedWechatAccounts(userConfig);
  const telegramAdminUserIds = telegram.adminUserIds ?? [];
  const telegramHasConversationBindings = Boolean(
    Object.keys(telegramBindings.dm ?? {}).length > 0 ||
    Object.keys(telegramBindings.group ?? {}).length > 0 ||
    Object.keys(telegramBindings.topic ?? {}).length > 0 ||
    Object.values(telegramBindings.accounts ?? {}).some((accountBindings) =>
      Object.keys(accountBindings?.dm ?? {}).length > 0 ||
      Object.keys(accountBindings?.group ?? {}).length > 0 ||
      Object.keys(accountBindings?.topic ?? {}).length > 0
    )
  );

  if (!telegramEnabled && !feishuEnabled && !wechatEnabled) {
    issues.push('至少需要配置一个 channel（telegram、feishu 或 wechat）');
    suggestions.push('在 ~/.crewline/crewline.json 中配置 channel.telegram、channel.feishu 或 channel.wechat');
  }

  if (telegramEnabled) {
    const groupAllowFrom = telegram.groupAllowFrom ?? telegram.allowedUserIds;
    const rawTelegramAccounts = getUserTelegramAccounts(userConfig);
    if (!groupAllowFrom?.length && (Object.keys(telegramBindings.group ?? {}).length > 0 || Object.keys(telegramBindings.topic ?? {}).length > 0)) {
      issues.push('`channel.telegram.groupAllowFrom` 为空');
      suggestions.push('在 ~/.crewline/crewline.json 的 channel.telegram.groupAllowFrom 中填入允许触发群/话题机器人的 Telegram 用户 ID 数组');
    }
    if (!telegramHasConversationBindings && telegramAdminUserIds.length === 0) {
      issues.push('Telegram 绑定为空');
      suggestions.push(rawTelegramAccounts.length || Object.keys(rawTelegramAccounts ?? {}).length
        ? '在 ~/.crewline/crewline.json 中配置 channel.telegram.accounts.<botId>.bindings.dm/group/topic'
        : '在 ~/.crewline/crewline.json 中配置 channel.telegram.bindings.dm/group/topic');
    }
    const enabledTelegramAccounts = Object.entries(telegramAccounts).filter(([, account]) => account.enabled !== false);
    if (enabledTelegramAccounts.length > 0) {
      for (const [accountId, account] of enabledTelegramAccounts) {
        const token = account.botToken ?? account.token ?? null;
        const tokenBotId = String(token ?? '').split(':', 1)[0]?.trim?.() ?? '';
        if (!token) {
          issues.push(`Telegram 账号 '${accountId}' 缺少 botToken`);
          suggestions.push(`在 channel.telegram.accounts.${accountId}.botToken 中填写机器人 token`);
        } else if (!/^\d+$/.test(tokenBotId)) {
          issues.push(`Telegram 账号 '${accountId}' 的 botToken 格式无效`);
          suggestions.push(`将 channel.telegram.accounts.${accountId}.botToken 改为 <bot_id>:<secret> 格式`);
        } else if (tokenBotId !== accountId) {
          issues.push(`Telegram 账号 key '${accountId}' 与 botToken 前缀 '${tokenBotId}' 不一致`);
          suggestions.push(`将 channel.telegram.accounts 的 key 改成 '${tokenBotId}'，或修正对应 botToken`);
        }
      }
    } else {
      issues.push('缺少 Telegram 账号配置');
      suggestions.push('在 channel.telegram.accounts.<botId>.botToken 中填写机器人 token');
    }
  }

  if (feishuEnabled) {
    const enabledAccounts = Object.entries(feishuAccounts).filter(([, account]) => account.enabled !== false);
    const globalFeishuAllowFrom = userConfig?.channel?.feishu?.groupAllowFrom ?? [];
    const hasAnyAccountBinding = enabledAccounts.some(([, account]) => hasAnyFeishuBinding(account.bindings));
    const feishuAdminUserIds = userConfig?.channel?.feishu?.adminUserIds ?? [];
    if (!hasAnyAccountBinding && feishuAdminUserIds.length === 0) {
      issues.push('Feishu 绑定为空');
      suggestions.push('在 ~/.crewline/crewline.json 中配置 channel.feishu.accounts.<appId>.bindings.dm/group');
    }
    if (!Array.isArray(globalFeishuAllowFrom) || globalFeishuAllowFrom.length === 0) {
      issues.push('`channel.feishu.groupAllowFrom` 为空');
      suggestions.push('在 channel.feishu.groupAllowFrom 中配置全局允许的飞书 open_id 列表');
    }
    const missingAccounts = enabledAccounts.filter(([, account]) =>
      !(account.appId && account.appSecret)
    );
    if (missingAccounts.length > 0) {
      for (const [accountId] of missingAccounts) {
        issues.push(`Feishu 账号 '${accountId}' 缺少凭证`);
        suggestions.push(`在 channel.feishu.accounts 中为账号 '${accountId}' 配置 appId / appSecret`);
      }
    }
  }

  if (wechatEnabled) {
    const rawWechatAccounts = getUserWechatAccounts(userConfig);
    if (!hasAnyWechatBinding(wechatBindings) && rawWechatAccounts.length === 0) {
      issues.push('WeChat 绑定为空');
      suggestions.push('在 ~/.crewline/crewline.json 中配置 channel.wechat.bindings.dm');
    }
    if (rawWechatAccounts.length > 0) {
      const missingAccountIds = rawWechatAccounts.filter((account) => !account?.accountId?.trim?.());
      if (missingAccountIds.length > 0) {
        issues.push('存在缺少 accountId 的 WeChat 账号配置');
        suggestions.push('为每个 channel.wechat.accounts.<accountId> 项补充 accountId');
      }
      const hasAnyAccountBinding = Object.values(wechatAccounts).some((account) => hasAnyWechatBinding(account.bindings));
      if (!hasAnyAccountBinding) {
        issues.push('WeChat 账号绑定为空');
        suggestions.push('在 channel.wechat.accounts.<accountId>.bindings.dm 中配置用户绑定');
      }
    }
    suggestions.push('首次使用前执行 `crewline wechat login` 完成扫码登录');
  }

  if (!userConfig?.agents?.providers || Object.keys(userConfig.agents.providers).length === 0) {
    issues.push('`agents.providers` 为空');
    suggestions.push('至少配置一个 provider，例如 `codex`');
  }

  if (!userConfig?.agents?.instances || Object.keys(userConfig.agents.instances).length === 0) {
    issues.push('`agents.instances` 为空');
    suggestions.push('至少配置一个 instance，并给出真实 cwd');
  }

  for (const [instanceId, instance] of Object.entries(userConfig?.agents?.instances ?? {})) {
    if (!instance?.cwd) {
      issues.push(`instance '${instanceId}' 没有 cwd`);
      suggestions.push(`为 instance '${instanceId}' 配置真实 cwd`);
      continue;
    }
    if (!fs.existsSync(instance.cwd)) {
      issues.push(`instance '${instanceId}' 的 cwd 不存在: ${instance.cwd}`);
      suggestions.push(`创建目录或修改 ~/.crewline/crewline.json 中 ${instanceId} 的 cwd`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    suggestions: [...new Set(suggestions)]
  };
}
