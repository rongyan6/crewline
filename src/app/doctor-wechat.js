import { loadResolvedRuntimeConfig } from './runtime-config.js';
import {
  listWechatAccounts,
  probeWechatChannel,
  resolveWechatBridgeConfig
} from '../channel/wechat/wechat-bridge.js';

async function main() {
  const { configPath, systemConfigPath, config } = await loadResolvedRuntimeConfig();
  const wechat = config.wechat ?? config.channel?.wechat ?? {};
  const bridgeConfig = resolveWechatBridgeConfig(wechat, { dataDir: config.runtime?.dataDir });
  const accountBindings = Object.entries(wechat.accounts ?? {}).map(([accountId, account]) => ({
    accountId,
    bindings: account?.bindings ?? { dm: {} }
  }));
  const report = {
    configPath,
    systemConfigPath,
    enabled: wechat.enabled === true,
    bindings: accountBindings.length > 0 ? { accounts: accountBindings } : (wechat.bindings ?? { dm: {} }),
    bridge: bridgeConfig,
    accounts: listWechatAccounts({ bridgeConfig })
  };

  const blockers = [];
  if (wechat.enabled !== true) {
    blockers.push('channel.wechat.enabled is not true');
  }
  const hasTopLevelBindings = Object.keys(wechat.bindings?.dm ?? {}).length > 0;
  const hasAccountBindings = accountBindings.some((account) => Object.keys(account?.bindings?.dm ?? {}).length > 0);
  if (!hasTopLevelBindings && !hasAccountBindings) {
    blockers.push('channel.wechat.bindings.dm or channel.wechat.accounts.<accountId>.bindings.dm is empty');
  }
  report.status = await probeWechatChannel({
    config: wechat,
    dataDir: config.runtime?.dataDir
  });
  report.inboundSupport = 'long-poll';

  if (report.status.ok !== true) {
    blockers.push(report.status.reason ?? 'WeChat bridge probe failed');
  }

  report.blockers = blockers;
  report.ok = blockers.length === 0;
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
