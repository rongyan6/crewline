import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { TelegramNativePlugin } from '../channel/telegram/telegram-plugin.js';
import { FeishuChannelPlugin } from '../channel/feishu/feishu-plugin.js';
import { WechatChannelPlugin } from '../channel/wechat/wechat-plugin.js';
import { createOutboundMessage } from '../channel/host/outbound-message.js';
import { createLogger } from '../obs/logger.js';
import { loadResolvedRuntimeConfig } from './runtime-config.js';
import {
  buildResolvedFeishuAccounts,
  buildResolvedTelegramAccounts,
  buildResolvedWechatAccounts
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

function hasListFlag(options = {}) {
  return options.list === true;
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
  if (text.length === 0) {
    throw new Error('No stdin message content received.');
  }
  return text;
}

function resolveTextOption(options) {
  return firstDefinedOption(options, ['text', 'message']);
}

function resolveAttachmentOption(options) {
  const filePath = firstDefinedOption(options, ['file', 'media', 'media-path']);
  const imagePath = firstDefinedOption(options, ['image']);
  if (filePath !== undefined && imagePath !== undefined) {
    throw new Error('Use either `--file` or `--image`, not both.');
  }
  return {
    path: imagePath ?? filePath,
    kind: imagePath !== undefined ? 'image' : undefined
  };
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

export function parsePushCommand({ channel, argv = [] } = {}) {
  const normalizedChannel = normalizeFlagName(channel);
  if (!SUPPORTED_CHANNELS.has(normalizedChannel)) {
    throw new Error('Usage: crewline push <telegram|feishu|wechat> ...');
  }

  const options = parseOptionEntries(argv);
  const accountId = firstDefinedOption(options, ['account', 'account-id']);
  const format = firstDefinedOption(options, ['format']) ?? 'plain';
  const listMode = hasListFlag(options);
  const attachment = resolveAttachmentOption(options);

  switch (normalizedChannel) {
    case 'telegram': {
      if (listMode) {
        return {
          channel: normalizedChannel,
          accountId: accountId ? String(accountId) : undefined,
          format,
          list: true
        };
      }
      const chatId = ensureRequiredOption(
        firstDefinedOption(options, ['chat-id', 'conversation-id']),
        'Telegram push requires `--chat-id`.'
      );
      const topicId = firstDefinedOption(options, ['topic-id', 'thread-id']);
      return {
        channel: normalizedChannel,
        accountId: accountId ? String(accountId) : undefined,
        format,
        useStdin: options.stdin === true,
        text: resolveTextOption(options),
        attachment,
        conversationRef: {
          channel: 'telegram',
          accountId: accountId ? String(accountId) : undefined,
          conversationId: chatId,
          participantId: null,
          scope: resolveTelegramScope(chatId, topicId),
          topicId: topicId ? String(topicId) : undefined
        }
      };
    }
    case 'feishu': {
      if (listMode) {
        return {
          channel: normalizedChannel,
          accountId: accountId ? String(accountId) : undefined,
          format,
          list: true
        };
      }
      const chatId = ensureRequiredOption(
        firstDefinedOption(options, ['chat-id', 'conversation-id']),
        'Feishu push requires `--chat-id`.'
      );
      return {
        channel: normalizedChannel,
        accountId: accountId ? String(accountId) : undefined,
        format,
        useStdin: options.stdin === true,
        text: resolveTextOption(options),
        attachment,
        conversationRef: {
          channel: 'feishu',
          accountId: accountId ? String(accountId) : undefined,
          conversationId: chatId,
          participantId: null,
          scope: 'group'
        }
      };
    }
    case 'wechat': {
      if (listMode) {
        return {
          channel: normalizedChannel,
          accountId: accountId ? String(accountId) : undefined,
          format,
          list: true
        };
      }
      const resolvedAccountId = ensureRequiredOption(
        accountId,
        'WeChat push requires `--account`.'
      );
      const userId = ensureRequiredOption(
        firstDefinedOption(options, ['user-id', 'participant-id', 'to']),
        'WeChat push requires `--user-id`.'
      );
      return {
        channel: normalizedChannel,
        accountId: resolvedAccountId,
        format,
        useStdin: options.stdin === true,
        text: resolveTextOption(options),
        attachment,
        conversationRef: {
          channel: 'wechat',
          accountId: resolvedAccountId,
          conversationId: userId,
          participantId: userId,
          scope: 'dm'
        }
      };
    }
    default:
      throw new Error('Usage: crewline push <telegram|feishu|wechat> ...');
  }
}

function resolveOutboundText(spec, stdinText) {
  if (spec.text !== undefined && spec.useStdin) {
    throw new Error('Use either `--text` or `--stdin`, not both.');
  }
  const text = spec.useStdin ? stdinText : spec.text;
  if ((text === undefined || text === null || String(text).length === 0) && !spec.attachment?.path) {
    throw new Error('Push message requires text or a media file. Use `--text`, `--stdin`, `--file`, or `--image`.');
  }
  return text === undefined || text === null ? '' : String(text);
}

async function resolveOutboundAttachments(spec) {
  const attachmentPath = spec.attachment?.path;
  if (!attachmentPath) return [];
  const resolvedPath = path.resolve(String(attachmentPath));
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`Push attachment not found: ${resolvedPath}`);
  }
  return [{
    kind: spec.attachment.kind,
    localPath: resolvedPath
  }];
}

function createPluginFactories() {
  return {
    telegram: ({ config, logger }) => new TelegramNativePlugin({
      config: config.channel?.telegram ?? config.telegram,
      logger,
      dataDir: config.runtime?.dataDir,
      secrets: {
        telegramBotToken: config.secrets?.telegramBotToken,
        telegramAccounts: config.secrets?.telegramAccounts
      }
    }),
    feishu: ({ config, logger }) => new FeishuChannelPlugin({
      config: config.channel?.feishu ?? config.feishu,
      logger,
      dataDir: config.runtime?.dataDir,
      secrets: {
        appId: config.secrets?.feishuAppId,
        appSecret: config.secrets?.feishuAppSecret,
        feishuAccounts: config.secrets?.feishuAccounts
      }
    }),
    wechat: ({ config, logger }) => new WechatChannelPlugin({
      config: config.channel?.wechat ?? config.wechat,
      logger,
      dataDir: config.runtime?.dataDir
    })
  };
}

function createTargetBuckets() {
  return {
    dm: [],
    group: [],
    topic: []
  };
}

function compareNullable(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''));
}

function sortTargets(targets = []) {
  return [...targets].sort((left, right) =>
    compareNullable(left.accountId, right.accountId) ||
    compareNullable(left.chatId, right.chatId) ||
    compareNullable(left.userId, right.userId) ||
    compareNullable(left.participantId, right.participantId) ||
    compareNullable(left.topicId, right.topicId)
  );
}

function buildSendKey(scope, target = {}) {
  return JSON.stringify({
    scope,
    accountId: target.accountId ?? null,
    chatId: target.chatId ?? null,
    topicId: target.topicId ?? null,
    userId: target.userId ?? null
  });
}

function compactTarget(target = {}) {
  return Object.fromEntries(
    Object.entries(target).filter(([, value]) => value !== undefined && value !== null)
  );
}

function mergeTargetEntries(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null) {
      merged[key] = value;
    }
  }
  const existingSource = existing.source;
  const incomingSource = incoming.source;
  if (existingSource && incomingSource && existingSource !== incomingSource) {
    merged.source = 'config+runtime';
  }
  return merged;
}

function bucketTarget(targets, target) {
  const scope = target.scope;
  if (!targets[scope]) return;
  const key = JSON.stringify({
    scope,
    accountId: target.accountId ?? null,
    chatId: target.chatId ?? null,
    topicId: target.topicId ?? null,
    userId: target.userId ?? null
  });
  const bucket = targets[scope];
  if (bucket.some((entry) => JSON.stringify({
    scope,
    accountId: entry.accountId ?? null,
    chatId: entry.chatId ?? null,
    topicId: entry.topicId ?? null,
    userId: entry.userId ?? null
  }) === key)) return;
  const { scope: _scope, ...rest } = target;
  bucket.push(rest);
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
    if (!line) return null;
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function matchesAccountFilter(accountId, filterAccountId) {
  if (!filterAccountId) return true;
  return String(accountId ?? '') === String(filterAccountId);
}

function collectConfigTargets({ channel, config, accountId }) {
  const targets = createTargetBuckets();
  if (channel === 'telegram') {
    const accounts = buildResolvedTelegramAccounts(config);
    for (const [resolvedAccountId, resolved] of Object.entries(accounts)) {
      if (!matchesAccountFilter(resolvedAccountId, accountId)) continue;
      for (const chatId of Object.keys(resolved.bindings?.dm ?? {})) {
        bucketTarget(targets, {
          scope: 'dm',
          accountId: resolvedAccountId,
          chatId,
          source: 'config'
        });
      }
      for (const chatId of Object.keys(resolved.bindings?.group ?? {})) {
        bucketTarget(targets, {
          scope: 'group',
          accountId: resolvedAccountId,
          chatId,
          source: 'config'
        });
      }
      for (const topicKey of Object.keys(resolved.bindings?.topic ?? {})) {
        const splitAt = topicKey.lastIndexOf(':');
        if (splitAt <= 0) continue;
        bucketTarget(targets, {
          scope: 'topic',
          accountId: resolvedAccountId,
          chatId: topicKey.slice(0, splitAt),
          topicId: topicKey.slice(splitAt + 1),
          source: 'config'
        });
      }
    }
  }
  if (channel === 'feishu') {
    const accounts = buildResolvedFeishuAccounts(config);
    for (const [resolvedAccountId, resolved] of Object.entries(accounts)) {
      if (!matchesAccountFilter(resolvedAccountId, accountId)) continue;
      for (const chatId of Object.keys(resolved.bindings?.group ?? {})) {
        bucketTarget(targets, {
          scope: 'group',
          accountId: resolvedAccountId,
          chatId,
          source: 'config'
        });
      }
    }
  }
  if (channel === 'wechat') {
    const accounts = buildResolvedWechatAccounts(config);
    for (const [resolvedAccountId, resolved] of Object.entries(accounts)) {
      if (!matchesAccountFilter(resolvedAccountId, accountId)) continue;
      for (const userId of Object.keys(resolved.bindings?.dm ?? {})) {
        bucketTarget(targets, {
          scope: 'dm',
          accountId: resolvedAccountId,
          userId,
          source: 'config'
        });
      }
    }
  }
  return targets;
}

async function collectRuntimeTargets({ channel, dataDir, accountId }) {
  const targets = createTargetBuckets();
  const files = await listJsonlFiles(path.join(dataDir, 'conversations', channel));
  for (const filePath of files) {
    const entry = await readFirstJsonLine(filePath);
    if (!entry) continue;
    if (!matchesAccountFilter(entry.accountId, accountId)) continue;
    if (channel === 'telegram') {
      bucketTarget(targets, {
        scope: entry.scope,
        accountId: entry.accountId ?? null,
        chatId: entry.conversationId ?? null,
        topicId: entry.topicId ?? null,
        participantId: entry.participantId ?? null,
        source: 'runtime'
      });
    }
    if (channel === 'feishu') {
      bucketTarget(targets, {
        scope: entry.scope,
        accountId: entry.accountId ?? null,
        chatId: entry.conversationId ?? null,
        participantId: entry.participantId ?? null,
        source: 'runtime'
      });
    }
    if (channel === 'wechat') {
      bucketTarget(targets, {
        scope: entry.scope,
        accountId: entry.accountId ?? null,
        userId: entry.participantId ?? entry.conversationId ?? null,
        source: 'runtime'
      });
    }
  }
  return targets;
}

function mergeTargetBuckets(...buckets) {
  const merged = createTargetBuckets();
  for (const bucket of buckets) {
    for (const scope of Object.keys(merged)) {
      for (const entry of bucket?.[scope] ?? []) {
        bucketTarget(merged, { scope, ...entry });
      }
    }
  }
  const finalize = (scope, entries) => {
    const byKey = new Map();
    for (const entry of sortTargets(entries)) {
      const key = buildSendKey(scope, entry);
      byKey.set(key, byKey.has(key)
        ? mergeTargetEntries(byKey.get(key), entry)
        : entry);
    }
    return [...byKey.values()].map(compactTarget);
  };
  return {
    dm: finalize('dm', merged.dm),
    group: finalize('group', merged.group),
    topic: finalize('topic', merged.topic)
  };
}

async function listPushTargets({ channel, accountId, config }) {
  const configTargets = collectConfigTargets({ channel, config, accountId });
  const runtimeTargets = await collectRuntimeTargets({
    channel,
    dataDir: config.runtime?.dataDir,
    accountId
  });
  return mergeTargetBuckets(configTargets, runtimeTargets);
}

export function formatPushHelp() {
  return [
    'Usage:',
    '  crewline push telegram --list [--account <id>]',
    '  crewline push feishu --list [--account <id>]',
    '  crewline push wechat --list [--account <id>]',
    '  crewline push telegram --chat-id <id> [--topic-id <id>] [--account <id>] [--text <message> | --stdin] [--file <path> | --image <path>]',
    '  crewline push feishu --chat-id <id> [--account <id>] [--text <message> | --stdin] [--file <path> | --image <path>]',
    '  crewline push wechat --account <id> --user-id <id> [--text <message> | --stdin] [--file <path> | --image <path>]',
    '',
    'Examples:',
    '  crewline push telegram --list',
    '  crewline push feishu --list --account your_app_id',
    '  crewline push telegram --chat-id -1001234567890 --text "deploy finished"',
    '  crewline push telegram --chat-id -1001234567890 --topic-id 42 --stdin',
    '  crewline push telegram --chat-id -1001234567890 --image ./report.png',
    '  crewline push feishu --account your_app_id --chat-id oc_xxx --text "build passed"',
    '  crewline push wechat --account bot@im.bot --user-id wxid_xxx --file ./report.pdf'
  ].join('\n');
}

export async function runPushCommand({
  channel,
  argv = [],
  stdin = process.stdin,
  loadRuntimeConfig = loadResolvedRuntimeConfig,
  pluginFactories = createPluginFactories(),
  logger = createLogger()
} = {}) {
  const spec = parsePushCommand({ channel, argv });
  const { config } = await loadRuntimeConfig();
  if (spec.list === true) {
    return {
      ok: true,
      channel: spec.channel,
      accountId: spec.accountId ?? null,
      targets: await listPushTargets({
        channel: spec.channel,
        accountId: spec.accountId,
        config
      })
    };
  }
  const stdinText = spec.useStdin ? await readTextFromStdin(stdin) : undefined;
  const text = resolveOutboundText(spec, stdinText);
  const attachments = await resolveOutboundAttachments(spec);
  const createPlugin = pluginFactories[spec.channel];
  if (typeof createPlugin !== 'function') {
    throw new Error(`Push channel is not supported: ${spec.channel}`);
  }

  const plugin = createPlugin({ config, logger });
  if (!plugin || typeof plugin.send !== 'function') {
    throw new Error(`Push channel is not available: ${spec.channel}`);
  }

  const outboundMessage = createOutboundMessage({
    channel: spec.channel,
    accountId: spec.accountId,
    conversationRef: spec.conversationRef,
    text,
    attachments,
    format: spec.format
  });
  const result = await plugin.send(outboundMessage);
  return {
    ok: true,
    channel: spec.channel,
    accountId: spec.accountId ?? null,
    conversationId: spec.conversationRef.conversationId,
    topicId: spec.conversationRef.topicId ?? null,
    messageId: result?.messageId ?? null,
    target: result?.target ?? spec.conversationRef.participantId ?? spec.conversationRef.conversationId
  };
}
