import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAdminCommand, formatAdminHelp } from './admin-command.js';
import {
  applyAdminUser,
  applyAgentAdd,
  applyAgentCwd,
  applyConversationRegistration,
  getExistingRegistration,
  getPreferredAgentIdForRegistration,
  listAgentInstances
} from './admin-config.js';
import { loadResolvedRuntimeConfig, persistUserConfig } from '../app/runtime-config.js';
import { ensureConfigReady, formatReadinessMessage, getServiceStatus } from '../app/service-manager.js';
import { readServiceState } from '../app/service-state.js';
import { resolveDoctorScript } from '../app/doctor-command.js';
import { healthcheck } from '../obs/healthcheck.js';
import { readJson } from '../shared/utils/jsonl.js';
import { conversationLogPath } from '../channel/host/conversation-ref.js';

const defaultAdminDeps = {
  loadResolvedRuntimeConfig,
  persistUserConfig,
  ensureConfigReady,
  formatReadinessMessage,
  getServiceStatus,
  readServiceState,
  resolveDoctorScript,
  healthcheck,
  readJson,
  spawn
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function findCrewlinePackageRoot(startDir = moduleDir) {
  let current = startDir;
  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson?.name === 'crewline') {
        return current;
      }
    } catch {
      // Walk upward until we find Crewline's package root.
    }

    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function resolveCliEntrypoint(baseDir = findCrewlinePackageRoot()) {
  const candidates = [
    path.resolve(baseDir, 'bin', 'crewline.js'),
    path.resolve(baseDir, 'dist', 'crewline.js')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function scheduleServiceCommand(command, deps = defaultAdminDeps) {
  if (typeof deps.scheduleServiceCommand === 'function') {
    return deps.scheduleServiceCommand(command);
  }
  const packageRoot = findCrewlinePackageRoot();
  const cliEntrypoint = resolveCliEntrypoint(packageRoot);
  const child = deps.spawn(process.execPath, [cliEntrypoint, command], {
    detached: true,
    stdio: 'ignore',
    cwd: packageRoot,
    env: process.env
  });
  child.unref?.();
}

function formatList(items = []) {
  return items.length > 0 ? items.join('\n') : '无';
}

function getChannelAdminUserIds(config = {}, channelId) {
  const values = config?.channel?.[channelId]?.adminUserIds ?? config?.[channelId]?.adminUserIds ?? [];
  return new Set((values ?? []).map((value) => String(value)));
}

function canBootstrapRegistration({ command, inboundMessage, config }) {
  if (command?.name !== 'reg') return false;
  return getChannelAdminUserIds(config, inboundMessage?.channel).size === 0;
}

function isAuthorizedAdmin({ command, inboundMessage, config }) {
  const senderId = String(inboundMessage?.senderRef?.userId ?? '');
  if (!senderId) return false;
  const admins = getChannelAdminUserIds(config, inboundMessage.channel);
  return admins.has(senderId);
}

function resolveRegistrationScopeLabel(scope) {
  if (scope === 'dm') return '私聊';
  if (scope === 'group') return '群组';
  if (scope === 'topic') return 'Topic';
  return '当前会话';
}

function normalizeTelegramGeneralRegistration(inboundMessage = {}) {
  if (inboundMessage?.channel !== 'telegram') return inboundMessage;
  const ref = inboundMessage.conversationRef ?? {};
  const threadId = String(ref.topicId ?? inboundMessage.rawMeta?.messageThreadId ?? '');
  const isGeneralForumTopic = inboundMessage.rawMeta?.chatIsForum === true && ref.scope === 'topic' && threadId === '1';
  if (!isGeneralForumTopic) return inboundMessage;

  return {
    ...inboundMessage,
    conversationRef: {
      ...ref,
      scope: 'group',
      topicId: undefined
    },
    rawMeta: {
      ...(inboundMessage.rawMeta ?? {}),
      messageThreadId: undefined
    }
  };
}

function hasTelegramBootstrapConfig(loaded = {}, inboundMessage = {}) {
  const accountId = inboundMessage.accountId ?? 'default';
  const secretToken = loaded?.config?.secrets?.telegramAccounts?.[accountId]?.botToken
    ?? loaded?.config?.secrets?.telegramBotToken
    ?? null;
  const userToken = loaded?.userConfig?.channel?.telegram?.accounts?.[accountId]?.botToken
    ?? loaded?.userConfig?.telegram?.accounts?.[accountId]?.botToken
    ?? loaded?.userConfig?.channel?.telegram?.botToken
    ?? loaded?.userConfig?.telegram?.botToken
    ?? null;
  return Boolean(secretToken ?? userToken);
}

function hasFeishuBootstrapConfig(loaded = {}, inboundMessage = {}) {
  const accountId = inboundMessage.accountId ?? 'default';
  const secretAccount = loaded?.config?.secrets?.feishuAccounts?.[accountId]
    ?? { appId: loaded?.config?.secrets?.feishuAppId, appSecret: loaded?.config?.secrets?.feishuAppSecret };
  const userAccount = loaded?.userConfig?.channel?.feishu?.accounts?.[accountId]
    ?? loaded?.userConfig?.feishu?.accounts?.[accountId]
    ?? {};
  const appId = secretAccount?.appId ?? userAccount?.appId ?? accountId;
  const appSecret = secretAccount?.appSecret ?? userAccount?.appSecret ?? null;
  return Boolean(appId && appSecret);
}

function resolveRegistrationPrerequisiteError(loaded = {}, inboundMessage = {}) {
  if (inboundMessage?.channel === 'telegram' && !hasTelegramBootstrapConfig(loaded, inboundMessage)) {
    return '当前还没有 Telegram 基础接入配置，无法接收入站消息并完成注册。请先配置 channel.telegram.accounts.<botId>.botToken。';
  }
  if (inboundMessage?.channel === 'feishu' && !hasFeishuBootstrapConfig(loaded, inboundMessage)) {
    return '当前还没有飞书基础接入配置，无法接收入站消息并完成注册。请先配置 channel.feishu.accounts.<appId>.appSecret，并确保账号 key 或 appId 正确。';
  }
  return null;
}

async function runDoctorCapture(scope = null, deps = defaultAdminDeps) {
  if (typeof deps.runDoctorCapture === 'function') {
    return await deps.runDoctorCapture(scope);
  }
  if (!scope) {
    const readiness = await deps.ensureConfigReady();
    return readiness.ok ? 'Crewline 配置完整，可以启动。' : deps.formatReadinessMessage(readiness);
  }
  const script = deps.resolveDoctorScript(scope);
  if (!script) {
    return `不支持的 doctor 子命令：${scope}`;
  }
  return await new Promise((resolve) => {
    const child = deps.spawn(process.execPath, [script], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => resolve(`doctor 执行失败：${error?.message ?? String(error)}`));
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
  });
}

function summarizeStatus(status) {
  return [
    '服务状态：',
    `running=${status.running === true}`,
    `pid=${status.pid ?? 'N/A'}`,
    `launchd=${status.launchd?.loaded === true}`,
    `serviceState=${status.serviceState?.status ?? 'unknown'}`
  ].join('\n');
}

function summarizeHealth(report) {
  return [
    `健康度：${report.ok === true ? 'ok' : 'degraded'}`,
    `checkedAt=${report.checkedAt ?? 'N/A'}`,
    `runtime=${report.runtime?.ok === true ? 'ok' : 'fail'}`,
    `channels=${(report.channels ?? []).map((channel) => `${channel.channel}:${channel.ok === false ? 'fail' : 'ok'}`).join(', ') || 'none'}`,
    `readiness=${report.service?.readinessOk === true ? 'ok' : 'fail'}`,
    `serviceState=${report.service?.status ?? 'unknown'}`
  ].join('\n');
}

async function buildHealthReport(live = {}, deps = defaultAdminDeps) {
  if (typeof deps.buildHealthReport === 'function') {
    return await deps.buildHealthReport(live);
  }
  const readiness = await deps.ensureConfigReady();
  const status = await deps.getServiceStatus();
  const serviceState = await deps.readServiceState();
  const metricsPath = path.join(status.serviceState?.runtimeHome ?? live.runtimeHome ?? process.cwd(), 'metrics', 'snapshot.json');
  const metrics = await deps.readJson(metricsPath, null);
  return {
    ok: Boolean(readiness.ok && status.running && serviceState?.status !== 'failed'),
    checkedAt: new Date().toISOString(),
    runtime: {
      ok: Boolean(status.running),
      backend: 'acpx',
      pid: status.pid,
      launchd: status.launchd?.loaded ?? false
    },
    channels: [],
    stateStore: {
      ok: true,
      dataDir: status.serviceState?.runtimeHome ?? live.runtimeHome ?? process.cwd(),
      runtimeBindings: null,
      conversationLogs: null
    },
    metrics,
    service: {
      ...serviceState,
      readinessOk: readiness.ok,
      launchd: status.launchd,
      command: status.command,
      runtimePaths: status.paths
    }
  };
}

async function persistConfigMutation(loaded, nextConfig, deps = defaultAdminDeps) {
  await deps.persistUserConfig(loaded.configPath, nextConfig);
}

function getOption(command, key, fallbackIndex = null) {
  const value = command.options?.[key];
  if (value !== undefined) return value;
  if (fallbackIndex !== null) return command.args?.[fallbackIndex] ?? null;
  return null;
}

function isSupportedProviderId(providerId) {
  return providerId === 'claude' || providerId === 'codex';
}

function validateAgentCwd(cwd) {
  if (!path.isAbsolute(cwd)) {
    return 'cwd 必须是绝对路径。';
  }
  if (!fs.existsSync(cwd)) {
    return `cwd 不存在：${cwd}`;
  }
  return null;
}

function formatUnauthorizedAdminMessage(inboundMessage, hasConfiguredAdmins) {
  const baseText = hasConfiguredAdmins
    ? '当前用户没有管理权限。'
    : '当前用户没有管理权限，或还没有完成私聊 bootstrap。';

  if (inboundMessage?.channel !== 'feishu' || !hasConfiguredAdmins) {
    return baseText;
  }

  const senderOpenId = String(inboundMessage?.senderRef?.userId ?? '');
  const conversationId = String(inboundMessage?.conversationRef?.conversationId ?? '');
  const accountId = String(inboundMessage?.accountId ?? 'default');
  const command = String(inboundMessage?.text ?? '').trim();

  return [
    baseText,
    '',
    '用于配置飞书管理员的信息：',
    `open_id=${senderOpenId || 'N/A'}`,
    `chat_id=${conversationId || 'N/A'}`,
    `account_id=${accountId || 'N/A'}`,
    `command=${command || 'N/A'}`,
    '',
    `请把 open_id 加到 channel.feishu.adminUserIds。`
  ].join('\n');
}

async function isDuplicateAdminCommand({ inboundMessage, live = {} }) {
  const messageId = String(inboundMessage?.messageId ?? '').trim();
  const conversationRef = inboundMessage?.conversationRef;
  const stateStore = live?.stateStore;
  if (!messageId || !conversationRef || !stateStore?.dataDir || !stateStore?.conversationLog?.readAll) {
    return false;
  }

  const logEntries = await stateStore.conversationLog.readAll(conversationLogPath({
    dataDir: stateStore.dataDir,
    conversationRef
  }));
  return logEntries.some((entry) =>
    entry?.role === 'system' &&
    entry?.meta?.reason === 'admin-command' &&
    String(entry?.meta?.sourceMessageId ?? '') === messageId &&
    String(entry?.meta?.command ?? '').trim() === String(inboundMessage?.text ?? '').trim()
  );
}

export async function handleAdminCommand({ inboundMessage, config, live = {}, deps = {} }) {
  const services = { ...defaultAdminDeps, ...deps };
  const command = parseAdminCommand(inboundMessage?.text);
  if (!command) return null;
  if (await isDuplicateAdminCommand({ inboundMessage, live })) {
    return {
      handled: true,
      suppressReply: true
    };
  }

  const allowOutsideDm = command.name === 'reg';
  if (inboundMessage?.conversationRef?.scope !== 'dm' && !allowOutsideDm) {
    return {
      handled: true,
      text: '管理命令仅支持在私聊中使用，请转到机器人私聊后再执行。'
    };
  }

  const authorizedAdmin = isAuthorizedAdmin({ command, inboundMessage, config });
  if (!authorizedAdmin && !canBootstrapRegistration({ command, inboundMessage, config })) {
    const hasConfiguredAdmins = getChannelAdminUserIds(config, inboundMessage?.channel).size > 0;
    return {
      handled: true,
      text: formatUnauthorizedAdminMessage(inboundMessage, hasConfiguredAdmins)
    };
  }

  if (command.name === 'help') {
    return { handled: true, text: formatAdminHelp() };
  }

  if (command.name === 'status') {
    const status = await services.getServiceStatus();
    return { handled: true, text: summarizeStatus(status) };
  }

  if (command.name === 'health') {
    const report = await buildHealthReport(live, services);
    return { handled: true, text: summarizeHealth(report) };
  }

  if (command.name === 'doctor') {
    const scope = getOption(command, 'scope', 0);
    return {
      handled: true,
      text: await runDoctorCapture(scope ? String(scope).toLowerCase() : null, services)
    };
  }

  if (command.name === 'agents') {
    const loaded = await services.loadResolvedRuntimeConfig();
    const instances = listAgentInstances(loaded.userConfig);
    return {
      handled: true,
      text: instances.length === 0
        ? '当前没有配置 agent 实例。'
        : [
            'Agent 实例：',
            ...instances.map((instance) => `${instance.id} providerId=${instance.providerId} cwd=${instance.cwd}`)
          ].join('\n')
    };
  }

  if (command.name === 'user') {
    if (inboundMessage?.conversationRef?.scope !== 'dm') {
      return {
        handled: true,
        text: '/admin_user 仅支持在私聊中使用。'
      };
    }
    if (!['telegram', 'feishu'].includes(inboundMessage?.channel)) {
      return {
        handled: true,
        text: '/admin_user 当前仅支持 Telegram 和飞书私聊。'
      };
    }

    const loaded = await services.loadResolvedRuntimeConfig();
    const userId = String(getOption(command, 'userid', 0) ?? '').trim();
    if (!userId) {
      return {
        handled: true,
        text: '缺少参数。用法：/admin_user userId=<userId>'
      };
    }
    const adminUserIds = getChannelAdminUserIds(loaded.userConfig, inboundMessage.channel);
    if (adminUserIds.has(userId)) {
      return {
        handled: true,
        text: `用户 ${userId} 已经在 ${inboundMessage.channel} 的 adminUserIds 中，无需重复添加。`
      };
    }

    const nextConfig = applyAdminUser(loaded.userConfig, {
      channelId: inboundMessage.channel,
      userId
    });
    await persistConfigMutation(loaded, nextConfig, services);
    return {
      handled: true,
      text: `已将用户 ${userId} 加入 ${inboundMessage.channel} 的 adminUserIds。回执发出后会重启服务使配置立即生效。`,
      postSendAction: async () => {
        scheduleServiceCommand('restart', services);
      }
    };
  }

  if (command.name === 'stop') {
    return {
      handled: true,
      text: '收到停止指令，回执发出后将停止 Crewline。停止后无法远程启动，请谨慎使用。',
      postSendAction: async () => {
        scheduleServiceCommand('stop', services);
      }
    };
  }

  if (command.name === 'restart') {
    return {
      handled: true,
      text: '收到重启指令，回执发出后将重启 Crewline。',
      postSendAction: async () => {
        scheduleServiceCommand('restart', services);
      }
    };
  }

  if (command.name === 'agent_add') {
    const loaded = await services.loadResolvedRuntimeConfig();
    const id = getOption(command, 'agentid');
    const providerId = getOption(command, 'providerid');
    const cwd = getOption(command, 'cwd');
    if (!id || !providerId || !cwd) {
      return {
        handled: true,
        text: '缺少参数。用法：/admin_agent_add agentId=<agentId> providerId=<claude|codex> cwd=<cwd>'
      };
    }
    if (!isSupportedProviderId(providerId)) {
      return {
        handled: true,
        text: `providerId 仅支持 claude 或 codex：${providerId}`
      };
    }
    const cwdError = validateAgentCwd(cwd);
    if (cwdError) {
      return {
        handled: true,
        text: cwdError
      };
    }
    if (!loaded.userConfig?.agents?.providers?.[providerId]) {
      return {
        handled: true,
        text: `providerId 不存在：${providerId}`
      };
    }
    if (loaded.userConfig?.agents?.instances?.[id]) {
      return {
        handled: true,
        text: `agent 实例已存在：${id}`
      };
    }
    const nextConfig = applyAgentAdd(loaded.userConfig, { id, providerId, cwd });
    await persistConfigMutation(loaded, nextConfig, services);
    return {
      handled: true,
      text: `已添加 agent 实例 ${id}，回执发出后会重启服务使配置生效。`,
      postSendAction: async () => {
        scheduleServiceCommand('restart', services);
      }
    };
  }

  if (command.name === 'agent_cwd') {
    const loaded = await services.loadResolvedRuntimeConfig();
    const id = getOption(command, 'agentid');
    const cwd = getOption(command, 'cwd');
    if (!id || !cwd) {
      return {
        handled: true,
        text: '缺少参数。用法：/admin_agent_cwd agentId=<agentId> cwd=<cwd>'
      };
    }
    if (!loaded.userConfig?.agents?.instances?.[id]) {
      return {
        handled: true,
        text: `agent 实例不存在：${id}`
      };
    }
    const cwdError = validateAgentCwd(cwd);
    if (cwdError) {
      return {
        handled: true,
        text: cwdError
      };
    }
    const nextConfig = applyAgentCwd(loaded.userConfig, { id, cwd });
    await persistConfigMutation(loaded, nextConfig, services);
    return {
      handled: true,
      text: `已更新 ${id} 的 cwd。为确保旧 session 不再沿用旧目录，回执发出后会重启服务。`,
      postSendAction: async () => {
        scheduleServiceCommand('restart', services);
      }
    };
  }

  if (command.name === 'reg') {
    const registrationMessage = normalizeTelegramGeneralRegistration(inboundMessage);
    const scope = registrationMessage?.conversationRef?.scope;
    const scopeLabel = resolveRegistrationScopeLabel(scope);
    if (registrationMessage.channel === 'telegram' && !['dm', 'group', 'topic'].includes(scope)) {
      return {
        handled: true,
        text: '当前命令支持 Telegram 私聊/群组/Topic。'
      };
    }
    if (registrationMessage.channel === 'feishu' && !['dm', 'group'].includes(scope)) {
      return {
        handled: true,
        text: '当前命令支持飞书私聊和群聊。'
      };
    }
    if (registrationMessage.channel === 'wechat') {
      return {
        handled: true,
        text: 'WeChat 当前不支持 /admin_reg。'
      };
    }
    if (!['telegram', 'feishu'].includes(registrationMessage.channel)) {
      return {
        handled: true,
        text: '当前命令仅支持 Telegram 和飞书。'
      };
    }

    const loaded = await services.loadResolvedRuntimeConfig();
    const prerequisiteError = resolveRegistrationPrerequisiteError(loaded, registrationMessage);
    if (prerequisiteError) {
      return {
        handled: true,
        text: prerequisiteError
      };
    }
    const preferredAgentId = getPreferredAgentIdForRegistration(loaded.userConfig, registrationMessage);
    if (!preferredAgentId) {
      return {
        handled: true,
        text: '没有可用的 Agent 实例，无法注册当前会话。'
      };
    }

    const existing = getExistingRegistration(loaded.userConfig, registrationMessage);
    if (existing?.instanceId === preferredAgentId) {
      return {
        handled: true,
        text: `当前${scopeLabel}已注册到 Agent ${preferredAgentId}，无需重复配置。`
      };
    }

    const nextConfig = applyConversationRegistration(loaded.userConfig, registrationMessage, preferredAgentId);
    await persistConfigMutation(loaded, nextConfig, services);
    return {
      handled: true,
      text: `已将当前${scopeLabel}注册到 Agent ${preferredAgentId}，并写入发送者 ID。回执发出后会重启服务使配置立即生效。`,
      postSendAction: async () => {
        scheduleServiceCommand('restart', services);
      }
    };
  }

  return {
    handled: true,
    text: formatAdminHelp()
  };
}
