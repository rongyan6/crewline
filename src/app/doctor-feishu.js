import { loadConfig } from '../config/load-config.js';
import { createFeishuSdkClient } from '../channel/feishu/feishu-sdk.js';
import {
  buildResolvedFeishuAccounts,
  isFeishuConfigured
} from '../config/channel-config.js';
import { resolveRuntimePaths } from './runtime-paths.js';

function sanitizeUrlForReport(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return '[configured]';
  }
}

async function main() {
  const { configPath, runtimeHome } = resolveRuntimePaths();
  const userConfig = await loadConfig(configPath);
  const accounts = buildResolvedFeishuAccounts(userConfig);
  const enabledAccounts = Object.entries(accounts).filter(([, account]) => account.enabled !== false);
  const hasAnyAccountBinding = enabledAccounts.some(([, account]) =>
    Object.keys(account.bindings?.dm ?? {}).length > 0 || Object.keys(account.bindings?.group ?? {}).length > 0
  );
  const report = {
    configPath,
    runtimeHome,
    channelEnabled: userConfig?.channel?.feishu?.enabled === true,
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([accountId, account]) => [accountId, {
        enabled: account.enabled !== false,
        appIdPresent: Boolean(account.appId),
        appSecretPresent: Boolean(account.appSecret),
        network: account.network ?? { useSystemProxy: false },
        bindings: account.bindings
      }])
    ),
    proxyEnv: {
      http_proxy: sanitizeUrlForReport(process.env.http_proxy ?? process.env.HTTP_PROXY ?? null),
      https_proxy: sanitizeUrlForReport(process.env.https_proxy ?? process.env.HTTPS_PROXY ?? null)
    }
  };

  const blockers = [];
  if (!isFeishuConfigured(userConfig) || userConfig?.channel?.feishu?.enabled !== true) {
    blockers.push('channel.feishu.enabled is not true');
  }
  if (!hasAnyAccountBinding) {
    blockers.push('channel.feishu.accounts.<appId>.bindings.dm/group are empty');
  }

  for (const [accountId, account] of enabledAccounts) {
    if (!account.appId || !account.appSecret) {
      blockers.push(`Missing credentials for Feishu account '${accountId}'`);
    }
    if (!Array.isArray(account.groupAllowFrom) || account.groupAllowFrom.length === 0) {
      blockers.push(`Missing groupAllowFrom for Feishu account '${accountId}'`);
    }
  }

  if (blockers.length > 0) {
    report.ok = false;
    report.blockers = blockers;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  report.results = {};
  let allOk = true;
  for (const [accountId, account] of enabledAccounts) {
    const client = createFeishuSdkClient({
      appId: account.appId,
      appSecret: account.appSecret,
      network: account.network
    });

    try {
      const response = await client.request({
        method: 'POST',
        url: '/open-apis/bot/v1/openclaw_bot/ping',
        data: { needBotInfo: true }
      });
      const scopeResponse = await client.application.scope.list({
        path: { app_id: account.appId }
      });
      const tenantScopes = (scopeResponse?.data?.scopes ?? [])
        .filter((scope) => scope?.scope_type === 'tenant' && scope?.grant_status === 1 && scope?.scope_name)
        .map((scope) => scope.scope_name)
        .sort();
      report.results[accountId] = {
        ok: response?.code === 0,
        responseCode: response?.code ?? null,
        responseMessage: response?.msg ?? null,
        botInfo: response?.data?.pingBotInfo ?? null,
        tenantScopes,
        groupMessageDiagnosis: tenantScopes.includes('im:message.group_msg') || tenantScopes.includes('im:message.group_msg:readonly')
          ? 'tenant scope includes full group message receive'
          : tenantScopes.includes('im:message.group_at_msg:readonly')
            ? 'tenant scope guarantees only @bot group message receive'
            : 'tenant scope does not include group message receive'
      };
      if (response?.code !== 0) allOk = false;
    } catch (error) {
      allOk = false;
      report.results[accountId] = {
        ok: false,
        reason: error?.message ?? String(error)
      };
      const responseText = error?.response?.data;
      if (typeof responseText === 'string' && responseText.includes('The plain HTTP request was sent to HTTPS port')) {
        report.results[accountId].proxyDiagnosis = 'Detected HTTP proxy interception issue: the Feishu SDK request was sent as plain HTTP to an HTTPS endpoint. Check http_proxy/https_proxy behavior for Feishu traffic.';
      }
    }
  }
  report.ok = allOk;

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
