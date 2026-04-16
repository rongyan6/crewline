import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createInboundMessage } from '../channel/host/inbound-message.js';
import { createLogger } from '../obs/logger.js';
import { randomId } from '../shared/utils/ids.js';
import { loadResolvedRuntimeConfig } from './runtime-config.js';
import { bootstrap } from './bootstrap.js';
import { runPushCommand } from './push-command.js';
import {
  buildResolvedFeishuAccounts,
  buildResolvedTelegramAccounts
} from '../config/channel-config.js';

const SUPPORTED_CHANNELS = new Set(['telegram', 'feishu', 'wechat']);

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

function resolveTelegramScope(chatId, topicId) {
  if (topicId) return 'topic';
  return String(chatId).startsWith('-') ? 'group' : 'dm';
}

function ensureRequiredOption(value, message) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(message);
  }
  return String(value);
}

async function readTextFromStdin(stdin = process.stdin) {
  const stream = stdin instanceof Readable ? stdin : Readable.from(stdin ?? '');
  if (stream.isTTY === true) {
    throw new Error('`--stdin` requires piped input.');
  }
  let text = '';
  for await (const chunk of stream) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  if (!text) {
    throw new Error('No stdin trigger content received.');
  }
  return text;
}

function prefixTriggerText(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    throw new Error('Trigger message text is required. Use `--text` or `--stdin`.');
  }
  return normalized.startsWith('触发：') ? normalized : `触发：${normalized}`;
}

function createSyntheticSenderRef(channel) {
  return {
    userId: `synthetic-trigger:${channel}`,
    displayName: 'Synthetic Trigger',
    username: 'synthetic-trigger'
  };
}

function resolveSingleAccountId(accounts = {}, channelLabel) {
  const accountIds = Object.keys(accounts ?? {});
  if (accountIds.length === 1) return accountIds[0];
  if (accountIds.length === 0) {
    throw new Error(`No ${channelLabel} accounts are configured.`);
  }
  throw new Error(`${channelLabel} trigger requires \`--account\` when multiple accounts are configured.`);
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

export function parseTriggerCommand({ channel, argv = [] } = {}) {
  const normalizedChannel = normalizeFlagName(channel);
  if (!SUPPORTED_CHANNELS.has(normalizedChannel)) {
    throw new Error('Usage: crewline trigger <telegram|feishu|wechat> ...');
  }

  const options = parseOptionEntries(argv);
  if (options.list === true) {
    return {
      channel: normalizedChannel,
      list: true,
      argv
    };
  }

  const accountId = firstDefinedOption(options, ['account', 'account-id']);
  const text = firstDefinedOption(options, ['text', 'message']);
  const useStdin = options.stdin === true;

  switch (normalizedChannel) {
    case 'telegram': {
      const chatId = ensureRequiredOption(
        firstDefinedOption(options, ['chat-id', 'conversation-id']),
        'Telegram trigger requires `--chat-id`.'
      );
      const topicId = firstDefinedOption(options, ['topic-id', 'thread-id']);
      return {
        channel: normalizedChannel,
        accountId: accountId ? String(accountId) : undefined,
        text,
        useStdin,
        target: {
          chatId,
          topicId: topicId ? String(topicId) : undefined
        }
      };
    }
    case 'feishu': {
      const chatId = ensureRequiredOption(
        firstDefinedOption(options, ['chat-id', 'conversation-id']),
        'Feishu trigger requires `--chat-id`.'
      );
      const scope = firstDefinedOption(options, ['scope']);
      const participantId = firstDefinedOption(options, ['participant-id', 'open-id', 'sender-id']);
      return {
        channel: normalizedChannel,
        accountId: accountId ? String(accountId) : undefined,
        text,
        useStdin,
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
        'WeChat trigger requires `--account`.'
      );
      const userId = ensureRequiredOption(
        firstDefinedOption(options, ['user-id', 'participant-id', 'to']),
        'WeChat trigger requires `--user-id`.'
      );
      return {
        channel: normalizedChannel,
        accountId: resolvedAccountId,
        text,
        useStdin,
        target: {
          userId
        }
      };
    }
    default:
      throw new Error('Usage: crewline trigger <telegram|feishu|wechat> ...');
  }
}

async function resolveTriggerText(spec, stdin) {
  if (spec.text !== undefined && spec.useStdin) {
    throw new Error('Use either `--text` or `--stdin`, not both.');
  }
  const text = spec.useStdin ? await readTextFromStdin(stdin) : spec.text;
  return prefixTriggerText(text);
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
    throw new Error('Feishu trigger `--scope` only supports `dm` or `group`.');
  }
  const participantId = spec.target.participantId ?? record?.participantId ?? null;
  if (scope === 'dm' && !participantId) {
    throw new Error('Feishu dm trigger requires runtime conversation history or `--participant-id`.');
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
  throw new Error(`Unsupported trigger channel: ${spec.channel}`);
}

export function formatTriggerHelp() {
  return [
    'Usage:',
    '  crewline trigger telegram --list [--account <id>]',
    '  crewline trigger feishu --list [--account <id>]',
    '  crewline trigger wechat --list [--account <id>]',
    '  crewline trigger telegram --chat-id <id> [--topic-id <id>] [--account <id>] (--text <message> | --stdin)',
    '  crewline trigger feishu --chat-id <id> [--scope dm|group] [--participant-id <id>] [--account <id>] (--text <message> | --stdin)',
    '  crewline trigger wechat --account <id> --user-id <id> (--text <message> | --stdin)',
    '',
    'Behavior:',
    '  The command first sends a visible message like `触发：...`, then injects the same text into the bound Agent conversation.',
    '',
    'Examples:',
    '  crewline trigger telegram --chat-id -1001234567890 --text "构建失败，请检查"',
    '  crewline trigger telegram --chat-id -1001234567890 --topic-id 42 --stdin',
    '  crewline trigger feishu --chat-id oc_xxx --scope dm --participant-id ou_xxx --text "新告警"',
    '  crewline trigger wechat --account bot@im.bot --user-id wxid_xxx --text "定时巡检"'
  ].join('\n');
}

export async function runTriggerCommand({
  channel,
  argv = [],
  stdin = process.stdin,
  loadRuntimeConfig = loadResolvedRuntimeConfig,
  createApp = async ({ config }) => bootstrap({ config }),
  runListCommand = runPushCommand,
  logger = createLogger()
} = {}) {
  const spec = parseTriggerCommand({ channel, argv });
  if (spec.list === true) {
    return runListCommand({
      channel,
      argv,
      stdin,
      loadRuntimeConfig
    });
  }

  const { config } = await loadRuntimeConfig();
  const triggerText = await resolveTriggerText(spec, stdin);
  const conversationRef = await resolveConversationRef(spec, config);
  const app = await createApp({ config, logger });
  if (!app || typeof app.triggerInbound !== 'function') {
    throw new Error('Trigger handling is not available in the current app bootstrap.');
  }

  const inboundMessage = createInboundMessage({
    channel: spec.channel,
    accountId: conversationRef.accountId,
    conversationRef,
    senderRef: createSyntheticSenderRef(spec.channel),
    messageId: randomId('trigger'),
    text: triggerText,
    timestamp: new Date().toISOString(),
    rawMeta: {
      syntheticTrigger: true,
      triggerSource: 'cli',
      originalText: triggerText
    }
  });

  const result = await app.triggerInbound({
    inboundMessage,
    noticeText: triggerText
  });
  const triggerResult = result?.triggerResult?.result ?? null;
  return {
    ok: triggerResult?.ok !== false,
    channel: spec.channel,
    accountId: conversationRef.accountId ?? null,
    conversationId: conversationRef.conversationId,
    topicId: conversationRef.topicId ?? null,
    noticeMessageId: result?.noticeSendResult?.messageId ?? null,
    sessionId: result?.triggerResult?.session?.sessionId ?? null,
    outputText: triggerResult?.outputText ?? null,
    errorCode: triggerResult?.errorCode ?? null,
    errorMessage: triggerResult?.errorMessage ?? null
  };
}
