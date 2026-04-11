import fs from 'node:fs';
import { loadConfig, loadJsonConfig } from '../config/load-config.js';
import { resolveConfig } from '../config/resolve-config.js';
import { TelegramBotApi } from '../channel/telegram/telegram-api.js';
import { resolveRuntimePaths } from './runtime-paths.js';

function sanitizeUrlForReport(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return '[configured]';
  }
}

async function probeTelegram(api) {
  try {
    const me = await api.call('getMe', {});
    const updates = await api.call('getUpdates', { timeout: 0, limit: 1 });
    return {
      ok: true,
      me: {
        id: me.id,
        username: me.username,
        first_name: me.first_name
      },
      updatesCount: Array.isArray(updates) ? updates.length : 0
    };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

function collectBindingIds(bindings) {
  const telegram = bindings.telegram ?? {};
  return [
    ...Object.keys(telegram.dm ?? {}),
    ...Object.keys(telegram.group ?? {}),
    ...Object.keys(telegram.topic ?? {}),
    ...Object.entries(telegram.accounts ?? {}).flatMap(([accountId, accountBindings]) => [
      ...Object.keys(accountBindings?.dm ?? {}).map((id) => `${accountId}:dm:${id}`),
      ...Object.keys(accountBindings?.group ?? {}).map((id) => `${accountId}:group:${id}`),
      ...Object.keys(accountBindings?.topic ?? {}).map((id) => `${accountId}:topic:${id}`)
    ])
  ];
}

function collectBindingTargets(bindings) {
  const telegram = bindings.telegram ?? {};
  return {
    dm: telegram.dm ?? {},
    group: telegram.group ?? {},
    topic: telegram.topic ?? {},
    accounts: telegram.accounts ?? {}
  };
}

async function main() {
  const { runtimeHome, configPath, systemConfigPath } = resolveRuntimePaths();
  const userConfig = await loadConfig(configPath);
  const systemConfig = await loadJsonConfig(systemConfigPath, { optional: true });
  const config = resolveConfig(userConfig, systemConfig, {}, { configDir: runtimeHome });
  const telegramAccounts = Object.entries(config.telegram?.accounts ?? {});

  const bindingTargets = collectBindingTargets(config.bindings);
  const accountReports = Object.fromEntries(await Promise.all(
    telegramAccounts.map(async ([accountId, accountConfig]) => {
      const token = config.secrets?.telegramAccounts?.[accountId]?.botToken ?? null;
      const api = token
        ? new TelegramBotApi({
            token,
            timeoutSeconds: accountConfig?.polling?.timeoutSeconds ?? config.telegram?.polling?.timeoutSeconds ?? 30,
            proxy: accountConfig?.network?.proxy ?? config.telegram?.network?.proxy ?? null
          })
        : null;
      return [accountId, {
        groupAllowFrom: accountConfig.groupAllowFrom ?? [],
        streaming: accountConfig.streaming === true,
        bindingTargets: bindingTargets.accounts?.[accountId] ?? { dm: {}, group: {}, topic: {} },
        tokenPresent: Boolean(token),
        telegramProbe: api ? await probeTelegram(api) : { ok: false, reason: 'Missing botToken' }
      }];
    })
  ));
  const report = {
    configPath,
    systemConfigPath,
    groupAllowFrom: config.telegram.groupAllowFrom ?? [],
    bindingIds: collectBindingIds(config.bindings),
    bindingTargets,
    proxy: sanitizeUrlForReport(config.telegram.network?.proxy),
    cwdChecks: Object.fromEntries(
      Object.entries(config.agents.instances || {}).map(([id, cfg]) => [id, fs.existsSync(cfg.cwd)])
    ),
    tokenPresent: Boolean(config.secrets.telegramBotToken),
    telegramProbe: config.secrets.telegramBotToken
      ? await probeTelegram(new TelegramBotApi({
          token: config.secrets.telegramBotToken,
          timeoutSeconds: config.telegram?.polling?.timeoutSeconds ?? 30,
          proxy: config.telegram?.network?.proxy ?? null
        }))
      : { ok: false, reason: 'Missing channel.telegram.accounts.<botId>.botToken' },
    accounts: accountReports
  };

  const blockers = [];
  if (report.groupAllowFrom.length === 0) blockers.push('telegram.groupAllowFrom is empty');
  if (Object.keys(accountReports).length > 0) {
    for (const [accountId, accountReport] of Object.entries(accountReports)) {
      if (!accountReport.tokenPresent) blockers.push(`Missing channel.telegram.accounts.${accountId}.botToken`);
      if (!accountReport.telegramProbe.ok) blockers.push(`Telegram probe failed for ${accountId}: ${accountReport.telegramProbe.reason}`);
    }
  } else {
    if (!report.tokenPresent) blockers.push('Missing channel.telegram.accounts.<botId>.botToken');
    if (!report.telegramProbe.ok) blockers.push(`Telegram probe failed: ${report.telegramProbe.reason}`);
  }
  if (report.bindingIds.length === 0) blockers.push('bindings.telegram.dm|group|topic are empty');
  for (const [id, ok] of Object.entries(report.cwdChecks)) if (!ok) blockers.push(`Agent instance cwd does not exist: ${id}`);
  report.blockers = blockers;
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = blockers.length ? 2 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
