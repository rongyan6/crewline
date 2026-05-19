import fs from 'node:fs/promises';
import path from 'node:path';
import { loadResolvedRuntimeConfig } from './runtime-config.js';
import { runPushCommand } from './push-command.js';
import {
  buildResolvedFeishuAccounts,
  buildResolvedTelegramAccounts
} from '../config/channel-config.js';
import { runtimeBindingPath } from '../channel/host/conversation-ref.js';
import { AgentRegistry } from '../core/agents/agent-registry.js';
import { ConversationRouter } from '../core/router/conversation-router.js';
import { AcpxClient } from '../runtime/acp/acpx-client.js';
import { AcpRuntimeGateway } from '../runtime/acp/runtime-gateway.js';
import { RuntimeBindingStore } from '../state/store/runtime-binding-store.js';

const SUPPORTED_CHANNELS = new Set(['telegram', 'feishu', 'wechat']);
const SUPPORTED_ACTIONS = new Set(['list', 'reset']);

function normalizeFlagName(name = '') {
  return String(name).trim().toLowerCase();
}

function isFlagToken(token = '') {
  return typeof token === 'string' && token.startsWith('--');
}

function parseOptionEntries(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!isFlagToken(token)) continue;
    const trimmed = token.slice(2);
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex >= 0) {
      options[normalizeFlagName(trimmed.slice(0, equalsIndex))] = trimmed.slice(equalsIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !isFlagToken(next)) {
      options[normalizeFlagName(trimmed)] = next;
      index += 1;
      continue;
    }
    options[normalizeFlagName(trimmed)] = true;
  }
  return options;
}

function firstDefinedOption(options, names = []) {
  for (const name of names) {
    const value = options[normalizeFlagName(name)];
    if (value !== undefined) return value;
  }
  return undefined;
}

function ensureRequiredOption(value, message) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(message);
  }
  return String(value);
}

function resolveTelegramScope(chatId, topicId) {
  if (topicId) return 'topic';
  return String(chatId).startsWith('-') ? 'group' : 'dm';
}

function resolveSingleAccountId(accounts = {}, channelLabel) {
  const accountIds = Object.keys(accounts ?? {});
  if (accountIds.length === 1) return accountIds[0];
  if (accountIds.length === 0) {
    throw new Error(`No ${channelLabel} accounts are configured.`);
  }
  throw new Error(`${channelLabel} session command requires \`--account\` when multiple accounts are configured.`);
}

async function listJsonlFiles(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const resolved = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...await listJsonlFiles(resolved));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(resolved);
      }
    }
    return files;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readFirstJsonLine(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const line = content.split('\n').find((entry) => entry.trim());
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

async function findConversationRecord({ dataDir, channel, conversationId, accountId, scope } = {}) {
  if (!dataDir) return null;
  const files = await listJsonlFiles(path.join(dataDir, 'conversations', channel));
  for (const filePath of files) {
    const record = await readFirstJsonLine(filePath);
    if (!record) continue;
    if (String(record.conversationId ?? '') !== String(conversationId ?? '')) continue;
    if (accountId && String(record.accountId ?? '') !== String(accountId)) continue;
    if (scope && String(record.scope ?? '') !== String(scope)) continue;
    return record;
  }
  return null;
}

function parseResetSpec(channel, argv) {
  const options = parseOptionEntries(argv);
  const accountId = firstDefinedOption(options, ['account', 'account-id']);

  switch (channel) {
    case 'telegram': {
      const chatId = ensureRequiredOption(
        firstDefinedOption(options, ['chat-id', 'conversation-id']),
        'Telegram session reset requires `--chat-id`.'
      );
      const topicId = firstDefinedOption(options, ['topic-id', 'thread-id']);
      return {
        channel,
        action: 'reset',
        accountId: accountId ? String(accountId) : undefined,
        target: {
          chatId,
          topicId: topicId ? String(topicId) : undefined
        }
      };
    }
    case 'feishu': {
      const chatId = ensureRequiredOption(
        firstDefinedOption(options, ['chat-id', 'conversation-id']),
        'Feishu session reset requires `--chat-id`.'
      );
      const scope = firstDefinedOption(options, ['scope']);
      const participantId = firstDefinedOption(options, ['participant-id', 'open-id', 'sender-id']);
      return {
        channel,
        action: 'reset',
        accountId: accountId ? String(accountId) : undefined,
        target: {
          chatId,
          scope: scope ? normalizeFlagName(scope) : undefined,
          participantId: participantId ? String(participantId) : undefined
        }
      };
    }
    case 'wechat': {
      const resolvedAccountId = ensureRequiredOption(
        accountId,
        'WeChat session reset requires `--account`.'
      );
      const userId = ensureRequiredOption(
        firstDefinedOption(options, ['user-id', 'participant-id', 'to']),
        'WeChat session reset requires `--user-id`.'
      );
      return {
        channel,
        action: 'reset',
        accountId: resolvedAccountId,
        target: {
          userId
        }
      };
    }
    default:
      throw new Error('Usage: crewline session reset <telegram|feishu|wechat> ...');
  }
}

export function parseSessionCommand({ argv = [] } = {}) {
  const action = normalizeFlagName(argv[0]);
  const channel = normalizeFlagName(argv[1]);
  if (!SUPPORTED_ACTIONS.has(action) || !SUPPORTED_CHANNELS.has(channel)) {
    throw new Error('Usage: crewline session <list|reset> <telegram|feishu|wechat> ...');
  }
  const rest = argv.slice(2);
  if (action === 'list') {
    return {
      action,
      channel,
      argv: rest
    };
  }
  return parseResetSpec(channel, rest);
}

async function resolveTelegramConversationRef(spec, config) {
  const accounts = buildResolvedTelegramAccounts(config);
  const scope = resolveTelegramScope(spec.target.chatId, spec.target.topicId);
  let accountId = spec.accountId;
  if (!accountId) {
    const record = await findConversationRecord({
      dataDir: config.runtime?.dataDir,
      channel: 'telegram',
      conversationId: spec.target.chatId,
      scope
    });
    accountId = record?.accountId ?? resolveSingleAccountId(accounts, 'Telegram');
  }
  return {
    channel: 'telegram',
    accountId,
    conversationId: spec.target.chatId,
    participantId: scope === 'dm' ? spec.target.chatId : null,
    topicId: spec.target.topicId,
    scope
  };
}

async function resolveFeishuConversationRef(spec, config) {
  const accounts = buildResolvedFeishuAccounts(config);
  const record = await findConversationRecord({
    dataDir: config.runtime?.dataDir,
    channel: 'feishu',
    conversationId: spec.target.chatId,
    accountId: spec.accountId,
    scope: spec.target.scope
  });
  const accountId = spec.accountId
    ?? record?.accountId
    ?? resolveSingleAccountId(accounts, 'Feishu');
  const scope = spec.target.scope ?? record?.scope ?? 'group';
  if (scope !== 'dm' && scope !== 'group') {
    throw new Error('Feishu session reset `--scope` only supports `dm` or `group`.');
  }
  const participantId = spec.target.participantId ?? record?.participantId ?? null;
  if (scope === 'dm' && !participantId) {
    throw new Error('Feishu dm session reset requires runtime conversation history or `--participant-id`.');
  }
  return {
    channel: 'feishu',
    accountId,
    conversationId: spec.target.chatId,
    participantId,
    scope
  };
}

function resolveWechatConversationRef(spec) {
  return {
    channel: 'wechat',
    accountId: spec.accountId,
    conversationId: spec.target.userId,
    participantId: spec.target.userId,
    scope: 'dm'
  };
}

async function resolveConversationRef(spec, config) {
  if (spec.channel === 'telegram') {
    return resolveTelegramConversationRef(spec, config);
  }
  if (spec.channel === 'feishu') {
    return resolveFeishuConversationRef(spec, config);
  }
  if (spec.channel === 'wechat') {
    return resolveWechatConversationRef(spec, config);
  }
  throw new Error(`Unsupported session channel: ${spec.channel}`);
}

function createRouteDecision({ conversationRef, config }) {
  const agentRegistry = new AgentRegistry(config.agents);
  const router = new ConversationRouter({
    bindings: config.bindings,
    agentRegistry
  });
  return router.route({
    channel: conversationRef.channel,
    conversationRef
  });
}

function createRuntimeBindingStore(config) {
  return new RuntimeBindingStore((conversationRef) =>
    runtimeBindingPath({ dataDir: config.runtime?.dataDir, conversationRef })
  );
}

function createRuntimeGateway({ config, runtimeClient }) {
  return new AcpRuntimeGateway({
    client: runtimeClient ?? new AcpxClient({
      turnTimeoutMs: config.runtime?.acpxTurnTimeoutMs,
      queueTtlSeconds: config.runtime?.acpxQueueTtlSeconds
    })
  });
}

export function formatSessionHelp() {
  return [
    'Usage:',
    '  crewline session list telegram [--account <id>]',
    '  crewline session list feishu [--account <id>]',
    '  crewline session list wechat [--account <id>]',
    '  crewline session reset telegram --chat-id <id> [--topic-id <id>] [--account <id>]',
    '  crewline session reset feishu --chat-id <id> [--scope dm|group] [--participant-id <id>] [--account <id>]',
    '  crewline session reset wechat --account <id> --user-id <id>',
    '',
    'Behavior:',
    '  reset closes the current Agent runtime session when known, removes the stored runtime binding,',
    '  and lets the next inbound message create a fresh runtime session inside the running service.'
  ].join('\n');
}

export async function runSessionCommand({
  argv = [],
  stdin = process.stdin,
  loadRuntimeConfig = loadResolvedRuntimeConfig,
  runListCommand = runPushCommand,
  runtimeClient,
  runtimeGateway,
  runtimeBindingStore
} = {}) {
  const spec = parseSessionCommand({ argv });
  if (spec.action === 'list') {
    return runListCommand({
      channel: spec.channel,
      argv: ['--list', ...spec.argv],
      stdin,
      loadRuntimeConfig
    });
  }

  const { config } = await loadRuntimeConfig();
  const conversationRef = await resolveConversationRef(spec, config);
  const routeDecision = createRouteDecision({ conversationRef, config });
  const bindingStore = runtimeBindingStore ?? createRuntimeBindingStore(config);
  const existing = await bindingStore.get(conversationRef);
  let closeResult = null;
  let closeError = null;

  if (existing?.runtimeHandle) {
    const gateway = runtimeGateway ?? createRuntimeGateway({ config, runtimeClient });
    try {
      closeResult = await gateway.close({
        agentId: existing.agentName ?? routeDecision.agentName,
        runtimeHandle: existing.runtimeHandle,
        cwd: existing.resolvedCwd ?? routeDecision.resolvedCwd
      });
    } catch (error) {
      closeError = error?.message ?? String(error);
    }
  }

  await bindingStore.delete(conversationRef);

  return {
    ok: true,
    action: 'reset',
    channel: spec.channel,
    accountId: conversationRef.accountId ?? null,
    conversationId: conversationRef.conversationId,
    participantId: conversationRef.participantId ?? null,
    topicId: conversationRef.topicId ?? null,
    scope: conversationRef.scope,
    route: {
      instanceId: routeDecision.instanceId,
      agentName: routeDecision.agentName,
      cwd: routeDecision.resolvedCwd
    },
    hadRuntimeBinding: Boolean(existing),
    closedRuntime: closeResult?.ok === true,
    closeError,
    bindingDeleted: true,
    next: 'Next inbound message will create a fresh runtime session.'
  };
}
