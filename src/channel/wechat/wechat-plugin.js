import { CrewlineError } from '../../shared/errors/error-envelope.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';
import {
  getWechatTypingConfig,
  listWechatAccounts,
  normalizeWechatInboundEvent,
  pollWechatMessages,
  probeWechatChannel,
  resolveWechatBridgeConfig,
  sendWechatTyping,
  sendWechatMessage
} from './wechat-bridge.js';
import { createInboundMessage } from '../host/inbound-message.js';
import { buildWechatInboundText, ingestWechatAttachment } from './wechat-media.js';
import { isWechatDebugMode } from './wechat-debug.js';
import { resolveWechatSlashCommand } from './wechat-commands.js';

export class WechatChannelPlugin {
  constructor({
    config = {},
    logger,
    dataDir,
    bridge = {
      getTypingConfig: getWechatTypingConfig,
      listAccounts: listWechatAccounts,
      normalizeInbound: normalizeWechatInboundEvent,
      poll: pollWechatMessages,
      probe: probeWechatChannel,
      resolveConfig: resolveWechatBridgeConfig,
      resolveSlashCommand: resolveWechatSlashCommand,
      sendTyping: sendWechatTyping,
      send: sendWechatMessage
    }
  } = {}) {
    this.id = 'wechat';
    this.config = config;
    this.logger = logger;
    this.dataDir = dataDir;
    this.bridge = bridge;
    this.abortControllers = new Map();
    this.typingTicketCache = new Map();
  }

  isDebugMode(accountId) {
    return isWechatDebugMode(this.dataDir, accountId);
  }

  async start({ emitRawEvent } = {}) {
    const bridgeConfig = this.bridge.resolveConfig(this.config, { dataDir: this.dataDir });
    const accounts = this.bridge.listAccounts({ bridgeConfig });
    for (const account of accounts) {
      if (!account?.accountId || !account?.token) continue;
      const controller = new AbortController();
      this.abortControllers.set(account.accountId, controller);
      void this.bridge.poll({
        config: this.config,
        dataDir: this.dataDir,
        account,
        signal: controller.signal,
        logger: this.logger,
        onMessage: async (rawEvent) => emitRawEvent?.(rawEvent)
      }).catch((error) => {
        this.logger?.warn?.(`[wechat.poll:${account.accountId}] stopped: ${error?.message ?? String(error)}`);
      });
    }
    return true;
  }

  async stop() {
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
    return true;
  }

  async toInbound(rawEvent) {
    const bridgeConfig = this.bridge.resolveConfig(this.config, { dataDir: this.dataDir });
    const message = rawEvent.message ?? {};
    const timestamp = new Date(Number(message?.create_time_ms ?? Date.now())).toISOString();
    const attachment = await ingestWechatAttachment({
      cdnBaseUrl: bridgeConfig.cdnBaseUrl,
      dataDir: this.dataDir,
      message,
      timestamp
    });
    const normalized = this.bridge.normalizeInbound({
      accountId: rawEvent.accountId,
      message,
      bridgeConfig
    });
    if (!normalized) return [];
    const text = buildWechatInboundText({ message, attachment });
    if (!text) return [];
    const slashCommand = this.resolveLocalCommand({
      accountId: rawEvent.accountId,
      text,
      eventTimestamp: Number(message?.create_time_ms ?? 0)
    });
    return [createInboundMessage({
      channel: 'wechat',
      accountId: normalized.accountId,
      conversationRef: normalized.conversationRef,
      senderRef: normalized.senderRef,
      messageId: normalized.messageId,
      text,
      timestamp: normalized.timestamp,
      rawMeta: {
        ...normalized.rawMeta,
        attachments: attachment ? [attachment] : [],
        localReplyText: slashCommand?.localReplyText ?? (attachment?.downloadError
          ? '微信附件下载失败，请稍后重试。'
          : null),
        localReplyReason: slashCommand?.handled ? 'slash-command' : (attachment?.downloadError ? 'media-local-handling' : null)
      }
    })];
  }

  resolveLocalCommand({ accountId, text, eventTimestamp }) {
    return this.bridge.resolveSlashCommand?.({
      text,
      accountId,
      dataDir: this.dataDir,
      receivedAt: Date.now(),
      eventTimestamp
    }) ?? null;
  }

  async createTypingSession(inboundMessage) {
    const accountId = inboundMessage.accountId;
    const userId = inboundMessage.conversationRef?.participantId;
    const contextToken = inboundMessage.rawMeta?.contextToken;
    if (!accountId || !userId) return null;
    const cacheKey = `${accountId}:${userId}`;
    const cached = this.typingTicketCache.get(cacheKey) ?? null;
    let typingTicket = cached?.value ?? '';
    if (!typingTicket || (cached?.expiresAt ?? 0) <= Date.now()) {
      try {
        const config = await this.bridge.getTypingConfig({
          config: this.config,
          dataDir: this.dataDir,
          accountId,
          userId,
          contextToken
        });
        typingTicket = config.typingTicket ?? '';
        if (typingTicket) {
          this.typingTicketCache.set(cacheKey, {
            value: typingTicket,
            expiresAt: Date.now() + (24 * 60 * 60 * 1000)
          });
        }
      } catch (error) {
        this.logger?.debug?.(`[wechat.typing:${accountId}] getConfig failed: ${error?.message ?? String(error)}`);
        return null;
      }
    }
    if (!typingTicket) return null;
    try {
      await this.bridge.sendTyping({
        config: this.config,
        dataDir: this.dataDir,
        accountId,
        userId,
        typingTicket,
        status: 1
      });
    } catch (error) {
      this.logger?.debug?.(`[wechat.typing:${accountId}] start failed: ${error?.message ?? String(error)}`);
      return null;
    }
    return async () => {
      try {
        await this.bridge.sendTyping({
          config: this.config,
          dataDir: this.dataDir,
          accountId,
          userId,
          typingTicket,
          status: 2
        });
      } catch (error) {
        this.logger?.debug?.(`[wechat.typing:${accountId}] stop failed: ${error?.message ?? String(error)}`);
      }
    };
  }

  async send(outboundMessage) {
    try {
      return await this.bridge.send({
        config: this.config,
        dataDir: this.dataDir,
        outboundMessage
      });
    } catch (error) {
      throw new CrewlineError({
        code: ErrorCodes.CHANNEL_SEND_FAILED,
        layer: 'channel',
        recoverable: true,
        message: 'Failed to send WeChat message',
        cause: error
      });
    }
  }

  async healthcheck() {
    const result = await this.bridge.probe({
      config: this.config,
      dataDir: this.dataDir
    });
    return {
      ...result,
      channel: 'wechat'
    };
  }
}
