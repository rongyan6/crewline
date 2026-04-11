import { createInboundMessage } from '../host/inbound-message.js';
import { createOutboundMessage } from '../host/outbound-message.js';
import { CrewlineError } from '../../shared/errors/error-envelope.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';
import {
  createFeishuEventDispatcher,
  createFeishuSdkClient,
  createFeishuWsClient
} from './feishu-sdk.js';
import { listResolvedFeishuAccounts } from './feishu-accounts.js';
import { parseFeishuMessageText, resolveUnsupportedFeishuReply } from './feishu-parser.js';
import { shouldHandleFeishuInbound } from './feishu-policy.js';
import { ingestFeishuMedia } from './feishu-media.js';
import {
  buildStaticFeishuReply,
  patchFeishuReply,
  sendFeishuPendingReply,
  sendFeishuStreamingReply
} from './feishu-reply.js';

function isDirectChat(message) {
  return message?.chat_type === 'p2p';
}

function normalizeScope(message) {
  return isDirectChat(message) ? 'dm' : 'group';
}

async function resolveBotOpenId(client) {
  try {
    const response = await client.request({
      method: 'POST',
      url: '/open-apis/bot/v1/openclaw_bot/ping',
      data: { needBotInfo: true }
    });
    return response?.data?.pingBotInfo?.botID ?? undefined;
  } catch {
    return undefined;
  }
}

async function listTenantScopeNames(client, appId) {
  try {
    const response = await client.application.scope.list({
      path: { app_id: appId }
    });
    return new Set(
      (response?.data?.scopes ?? [])
        .filter((scope) => scope?.scope_type === 'tenant' && scope?.grant_status === 1 && scope?.scope_name)
        .map((scope) => String(scope.scope_name))
    );
  } catch {
    return new Set();
  }
}

function createAccountState({ account, sdk, logger }) {
  return {
    accountId: account.accountId,
    config: account.config,
    client: sdk.createClient({
      appId: account.secrets.appId,
      appSecret: account.secrets.appSecret,
      network: account.config.network
    }),
    wsClient: null,
    dispatcher: null,
    botOpenId: null,
    tenantScopes: new Set(),
    lastEventAt: 0,
    wsMonitor: null,
    restartingWs: false,
    logger
  };
}

function extractFeishuMessageDebug(event = {}) {
  const message = event?.message ?? {};
  const senderOpenId = event?.sender?.sender_id?.open_id ?? null;
  return {
    messageId: message.message_id ?? null,
    chatId: message.chat_id ?? null,
    chatType: message.chat_type ?? null,
    messageType: message.message_type ?? null,
    senderOpenId
  };
}

function buildInboundFromEvent({ event, accountState, timestamp, text, localReplyText, attachments }) {
  const message = event?.message;
  const sender = event?.sender;
  if (!message?.message_id || !message?.chat_id || !sender?.sender_id?.open_id) return [];

  return [
    createInboundMessage({
      channel: 'feishu',
      accountId: accountState.accountId,
      conversationRef: {
        channel: 'feishu',
        accountId: accountState.accountId,
        conversationId: String(message.chat_id),
        participantId: String(sender.sender_id.open_id),
        scope: normalizeScope(message)
      },
      senderRef: {
        userId: String(sender.sender_id.open_id),
        displayName: sender.sender_id?.user_id ?? sender.sender_id.open_id,
        username: sender.sender_id?.union_id
      },
      messageId: String(message.message_id),
      text: text || localReplyText,
      timestamp,
      rawMeta: {
        messageType: message.message_type,
        chatType: message.chat_type,
        localReplyText,
        attachments: attachments ?? []
      }
    })
  ];
}

export class FeishuChannelPlugin {
  constructor({
    config = {},
    logger,
    secrets = {},
    sdk = {
      createClient: createFeishuSdkClient,
      createEventDispatcher: createFeishuEventDispatcher,
      createWsClient: createFeishuWsClient
    },
    dataDir
  } = {}) {
    this.id = 'feishu';
    this.config = config;
    this.logger = logger;
    this.secrets = secrets;
    this.sdk = sdk;
    this.dataDir = dataDir;
    this.accounts = new Map();
    this.seenInboundMessageIds = new Map();
    this.inboundDedupTtlMs = Number(config.inboundDedupTtlMs ?? 5 * 60 * 1000);
    this.wsMonitorIntervalMs = Number(config.wsMonitorIntervalMs ?? 0);
    this.wsStaleMs = Number(config.wsStaleMs ?? 0);
  }

  buildInboundDedupKey(accountId, messageId) {
    return `${accountId}:${messageId}`;
  }

  pruneSeenInboundMessages(now = Date.now()) {
    if (this.seenInboundMessageIds.size === 0) return;
    for (const [key, expiresAt] of this.seenInboundMessageIds.entries()) {
      if (expiresAt <= now) {
        this.seenInboundMessageIds.delete(key);
      }
    }
  }

  markInboundMessageSeen(accountId, messageId, now = Date.now()) {
    this.pruneSeenInboundMessages(now);
    const key = this.buildInboundDedupKey(accountId, messageId);
    const expiresAt = this.seenInboundMessageIds.get(key);
    if (expiresAt && expiresAt > now) {
      return false;
    }
    this.seenInboundMessageIds.set(key, now + this.inboundDedupTtlMs);
    return true;
  }

  getResolvedAccounts() {
    return listResolvedFeishuAccounts(this.config, this.secrets);
  }

  isEnabled() {
    return this.getResolvedAccounts().some((account) =>
      account.config.enabled !== false && Boolean(account.secrets.appId && account.secrets.appSecret)
    );
  }

  getAccountState(accountId = 'default') {
    return this.accounts.get(accountId) ?? null;
  }

  resolveAccountRecord(accountId = 'default') {
    return this.getResolvedAccounts().find((account) => account.accountId === accountId) ?? null;
  }

  dispatchInboundEvent(emitRawEvent, accountId, data) {
    const state = this.getAccountState(accountId);
    if (state) {
      state.lastEventAt = Date.now();
    }
    const debug = extractFeishuMessageDebug(data);
    this.logger?.info?.(`[feishu.event:${accountId}] received`, debug);
    void Promise.resolve(emitRawEvent({ accountId, data })).catch((error) => {
      this.logger?.error?.(`[feishu.event:${accountId}] failed`, {
        ...debug,
        error: error?.message ?? String(error)
      });
    });
  }

  clearWsMonitor(state) {
    if (!state?.wsMonitor) return;
    clearInterval(state.wsMonitor);
    state.wsMonitor = null;
  }

  installWsMonitor(state, account, emitRawEvent) {
    if (!emitRawEvent || this.wsMonitorIntervalMs <= 0 || this.wsStaleMs <= 0) return;
    this.clearWsMonitor(state);
    state.wsMonitor = setInterval(() => {
      const idleMs = Date.now() - Number(state.lastEventAt || 0);
      if (state.restartingWs || idleMs < this.wsStaleMs) return;
      this.logger?.warn?.(`[feishu.ws:${account.accountId}] stale connection detected; restarting websocket`, {
        idleMs,
        staleMs: this.wsStaleMs
      });
      void this.restartAccountWs(account.accountId, emitRawEvent);
    }, this.wsMonitorIntervalMs);
    state.wsMonitor.unref?.();
  }

  async startAccountWs(state, account, emitRawEvent) {
    this.clearWsMonitor(state);
    try {
      state.wsClient?.close?.({ force: true });
    } catch {}

    state.dispatcher = this.sdk.createEventDispatcher({
      encryptKey: account.config.encryptKey ?? '',
      verificationToken: account.config.verificationToken ?? ''
    });
    state.dispatcher.register({
      'im.message.receive_v1': (data) => this.dispatchInboundEvent(emitRawEvent, account.accountId, data)
    });
    state.wsClient = this.sdk.createWsClient({
      appId: account.secrets.appId,
      appSecret: account.secrets.appSecret,
      network: account.config.network
    });
    state.lastEventAt = Date.now();
    this.installWsMonitor(state, account, emitRawEvent);
    Promise.resolve(state.wsClient.start({ eventDispatcher: state.dispatcher })).catch((error) => {
      this.logger?.warn?.(`[feishu.ws:${account.accountId}] ${error?.message ?? String(error)}`);
    });
  }

  async restartAccountWs(accountId, emitRawEvent) {
    const state = this.getAccountState(accountId);
    const account = this.resolveAccountRecord(accountId);
    if (!state || !account || !emitRawEvent || state.restartingWs) return;
    state.restartingWs = true;
    try {
      await this.startAccountWs(state, account, emitRawEvent);
    } finally {
      state.restartingWs = false;
    }
  }

  async ensureAccountState(accountId = 'default', { startWs = false, emitRawEvent } = {}) {
    const existing = this.getAccountState(accountId);
    if (existing) return existing;

    const account = this.resolveAccountRecord(accountId);
    if (!account || account.config.enabled === false || !account.secrets.appId || !account.secrets.appSecret) {
      return null;
    }

    const state = createAccountState({ account, sdk: this.sdk, logger: this.logger });
    state.botOpenId = await resolveBotOpenId(state.client);
    state.tenantScopes = await listTenantScopeNames(state.client, account.secrets.appId);
    const allMessagesConfigured = state.config.requireMention === false;
    if (allMessagesConfigured &&
      state.tenantScopes.has('im:message.group_at_msg:readonly') &&
      !state.tenantScopes.has('im:message.group_msg') &&
      !state.tenantScopes.has('im:message.group_msg:readonly')) {
      this.logger?.warn?.(
        `[feishu.scope:${account.accountId}] requireMention=false but tenant scopes only guarantee @ mentions; non-@ group delivery may be platform-limited`
      );
    }

    this.accounts.set(account.accountId, state);
    if (startWs && emitRawEvent) {
      await this.startAccountWs(state, account, emitRawEvent);
    }
    return state;
  }

  async start({ emitRawEvent } = {}) {
    const accounts = this.getResolvedAccounts().filter((account) =>
      account.config.enabled !== false && Boolean(account.secrets.appId && account.secrets.appSecret)
    );
    if (!emitRawEvent || accounts.length === 0) return true;

    for (const account of accounts) {
      await this.ensureAccountState(account.accountId, { startWs: true, emitRawEvent });
    }
    return true;
  }

  async stop() {
    for (const state of this.accounts.values()) {
      this.clearWsMonitor(state);
      try {
        state.wsClient?.close?.({ force: true });
      } catch {}
    }
    this.accounts.clear();
    this.seenInboundMessageIds.clear();
    return true;
  }

  async toInbound(rawEvent) {
    const accountId = rawEvent?.accountId ?? 'default';
    const event = rawEvent?.data ?? rawEvent;
    const accountState = await this.ensureAccountState(accountId);
    if (!accountState) {
      this.logger?.warn?.(`[feishu.inbound:${accountId}] drop event: account unavailable`, extractFeishuMessageDebug(event));
      return [];
    }

    const message = event?.message;
    const senderOpenId = event?.sender?.sender_id?.open_id;
    if (!message || !senderOpenId) {
      this.logger?.warn?.(`[feishu.inbound:${accountId}] drop event: missing message or sender`, extractFeishuMessageDebug(event));
      return [];
    }
    if (!this.markInboundMessageSeen(accountId, String(message.message_id))) {
      this.logger?.info?.(`[feishu.dedup:${accountId}] skip duplicate inbound ${message.message_id}`);
      return [];
    }

    const text = parseFeishuMessageText(message, { botOpenId: accountState.botOpenId });
    const policy = shouldHandleFeishuInbound({
      message,
      senderOpenId,
      accountState,
      text
    });
      this.logger?.info?.(`[feishu.policy:${accountId}] evaluated ${message.message_id}`, {
        ...extractFeishuMessageDebug(event),
        allowed: policy.allowed,
        reason: policy.reason ?? null,
        requireMention: accountState.config?.requireMention ?? null,
        groupAllowFrom: accountState.config?.groupAllowFrom ?? []
      });
    if (!policy.allowed) {
      this.logger?.info?.(`[feishu.policy:${accountId}] skip inbound ${message.message_id}`, {
        ...extractFeishuMessageDebug(event),
        reason: policy.reason ?? 'policy_blocked'
      });
      return [];
    }

    const timestamp = message.create_time ? new Date(Number(message.create_time)).toISOString() : new Date().toISOString();
    const attachment = await ingestFeishuMedia({
      client: accountState.client,
      dataDir: this.dataDir,
      message,
      timestamp
    });
    const localReplyText = attachment?.localReplyText
      ?? (!text && !attachment ? resolveUnsupportedFeishuReply(message.message_type ?? 'unknown') : null);
    const finalText = attachment?.summaryText ?? text;

    return buildInboundFromEvent({
      event,
      accountState,
      timestamp,
      text: finalText,
      localReplyText,
      attachments: attachment ? [attachment] : []
    });
  }

  async send(outboundMessage) {
    const accountState = await this.ensureAccountState(outboundMessage.accountId ?? 'default');
    if (!accountState) {
      throw new CrewlineError({
        code: ErrorCodes.CHANNEL_SEND_FAILED,
        layer: 'channel',
        recoverable: true,
        message: `Feishu account not active: ${outboundMessage.accountId ?? 'default'}`
      });
    }

    try {
      const footer = accountState.config.footer ?? {};
      const elapsedMs = outboundMessage.meta?.elapsedMs;
      const patchMessageId = outboundMessage.meta?.patchMessageId;
      if (patchMessageId) {
        return await patchFeishuReply({
          client: accountState.client,
          messageId: patchMessageId,
          text: outboundMessage.text || '…',
          footer,
          elapsedMs,
          status: outboundMessage.meta?.statusText ?? '已完成'
        });
      }

      if (outboundMessage.meta?.pending === true) {
        return await sendFeishuPendingReply({
          client: accountState.client,
          target: outboundMessage.conversationRef.conversationId,
          receiveIdType: 'chat_id',
          replyToMessageId: outboundMessage.replyTo,
          text: outboundMessage.text || '…',
          footer,
          statusText: outboundMessage.meta?.statusText ?? '生成中'
        });
      }

      if (accountState.config.streaming === true && outboundMessage.meta?.streamChunks) {
        return await sendFeishuStreamingReply({
          client: accountState.client,
          target: outboundMessage.conversationRef.conversationId,
          receiveIdType: 'chat_id',
          replyToMessageId: outboundMessage.replyTo,
          chunks: outboundMessage.meta.streamChunks,
          finalText: outboundMessage.text,
          footer,
          elapsedMs
        });
      }

      const text = buildStaticFeishuReply(outboundMessage.text, { footer, elapsedMs });
      if (outboundMessage.replyTo) {
        const response = await accountState.client.im.message.reply({
          path: { message_id: outboundMessage.replyTo },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text })
          }
        });
        return {
          ok: true,
          channel: 'feishu',
          messageId: response?.data?.message_id ?? ''
        };
      }

      const response = await accountState.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: outboundMessage.conversationRef.conversationId,
          msg_type: 'text',
          content: JSON.stringify({ text })
        }
      });
      return {
        ok: true,
        channel: 'feishu',
        messageId: response?.data?.message_id ?? ''
      };
    } catch (error) {
      throw new CrewlineError({
        code: ErrorCodes.CHANNEL_SEND_FAILED,
        layer: 'channel',
        recoverable: true,
        message: 'Failed to send Feishu message',
        cause: error
      });
    }
  }

  async healthcheck() {
    return {
      ok: this.isEnabled(),
      channel: 'feishu',
      accounts: Array.from(this.accounts.keys())
    };
  }
}

export function createFeishuLocalReply({ inboundMessage, text }) {
  return createOutboundMessage({
    channel: inboundMessage.channel,
    accountId: inboundMessage.accountId,
    conversationRef: inboundMessage.conversationRef,
    text
  });
}
