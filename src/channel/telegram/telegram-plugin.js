import { CrewlineError } from '../../shared/errors/error-envelope.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';
import { resolveTelegramConfig } from './telegram-config.js';
import { telegramUpdateToInbound, outboundToTelegramSendRequest } from './telegram-mapper.js';
import { sendTelegramMessage, splitText } from './telegram-send.js';
import { TelegramPollingLoop } from './telegram-polling.js';
import { createTelegramPollingErrorReporter } from './telegram-error-reporter.js';
import { TelegramBotApi } from './telegram-api.js';

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

function isTelegramApiClient(api) {
  return Boolean(api) && typeof api.sendMessage === 'function';
}

function listTelegramAccounts(config = {}, secrets = {}) {
  const explicitAccounts = Object.entries(config.accounts ?? {});
  if (explicitAccounts.length > 0) {
    return explicitAccounts.map(([accountId, accountConfig]) => ({
      accountId,
      config: resolveTelegramConfig(deepMerge(config, accountConfig)),
      token: secrets.telegramAccounts?.[accountId]?.botToken
        ?? accountConfig?.botToken
        ?? accountConfig?.token
        ?? null
    }));
  }

  return [{
    accountId: 'default',
    config: resolveTelegramConfig(config),
    token: secrets.telegramBotToken ?? config?.botToken ?? config?.token ?? null
  }];
}

export class TelegramNativePlugin {
  constructor({ api, config = {}, logger, dataDir, secrets = {} }) {
    this.id = 'telegram';
    this.apiOverride = api;
    this.config = config;
    this.logger = logger;
    this.dataDir = dataDir;
    this.secrets = secrets;
    this.accounts = new Map();
  }

  getResolvedAccounts() {
    return listTelegramAccounts(this.config, this.secrets);
  }

  resolveImplicitAccountId() {
    const accounts = this.getResolvedAccounts();
    return accounts.length === 1 ? accounts[0].accountId : null;
  }

  resolveProvidedApi(accountId) {
    if (isTelegramApiClient(this.apiOverride)) {
      return this.apiOverride;
    }
    if (this.apiOverride && typeof this.apiOverride === 'object') {
      const scopedApi = this.apiOverride[accountId] ?? this.apiOverride.default ?? null;
      if (isTelegramApiClient(scopedApi)) {
        return scopedApi;
      }
    }
    return null;
  }

  resolveAccountRecord(accountId = null) {
    const effectiveAccountId = accountId ?? this.resolveImplicitAccountId();
    if (!effectiveAccountId) return null;
    return this.getResolvedAccounts().find((account) => account.accountId === effectiveAccountId) ?? null;
  }

  async ensureAccountState(accountId = null) {
    const record = this.resolveAccountRecord(accountId);
    if (!record) return null;
    const existing = this.accounts.get(record.accountId);
    if (existing) return existing;

    const api = this.resolveProvidedApi(record.accountId) ?? (
      record.token
        ? new TelegramBotApi({
            token: record.token,
            timeoutSeconds: record.config.timeoutSeconds,
            proxy: record.config.network?.proxy ?? null
          })
        : null
    );

    if (!api) return null;

    const state = {
      accountId: record.accountId,
      config: record.config,
      api,
      token: record.token,
      offset: null,
      pollingLoop: null,
      botProfile: null
    };
    this.accounts.set(record.accountId, state);
    return state;
  }

  getAccountConfig(accountId = null) {
    return this.resolveAccountRecord(accountId)?.config ?? null;
  }

  async getAccountApi(accountId = null) {
    return (await this.ensureAccountState(accountId))?.api ?? null;
  }

  isEnabled() {
    return this.getResolvedAccounts().some((account) =>
      isTelegramApiClient(this.resolveProvidedApi(account.accountId)) || Boolean(account.token)
    );
  }

  async ensureBotProfile(accountId = null) {
    const state = await this.ensureAccountState(accountId);
    if (!state || state.botProfile || typeof state.api.getMe !== 'function') return state?.botProfile ?? null;
    try {
      state.botProfile = await state.api.getMe();
    } catch (error) {
      this.logger?.warn?.(`[telegram.bot:${state.accountId}] failed to resolve bot profile: ${error?.message ?? String(error)}`);
    }
    return state.botProfile;
  }

  async startAccount(state, emitRawEvent) {
    await this.ensureBotProfile(state.accountId);
    if (state.config.mode !== 'polling' || typeof state.api.getUpdates !== 'function' || !emitRawEvent) {
      return;
    }
    const reportPollingError = createTelegramPollingErrorReporter({ logger: this.logger });
    state.pollingLoop = new TelegramPollingLoop({
      fetchUpdates: async () => {
        const updates = await state.api.getUpdates({
          offset: state.offset ?? undefined,
          timeoutSeconds: state.config.timeoutSeconds
        });
        if (updates.length > 0) {
          state.offset = Math.max(...updates.map((update) => Number(update.update_id) || 0)) + 1;
        }
        return updates;
      },
      onError: async (error) => {
        reportPollingError(error);
      }
    });
    state.pollingLoop.start(async (update) => emitRawEvent({
      accountId: state.accountId,
      update
    }));
  }

  async start({ emitRawEvent } = {}) {
    for (const account of this.getResolvedAccounts()) {
      const state = await this.ensureAccountState(account.accountId);
      if (!state) continue;
      await this.startAccount(state, emitRawEvent);
    }
    return true;
  }

  async stop() {
    for (const state of this.accounts.values()) {
      state.pollingLoop?.stop();
    }
    return true;
  }

  async toInbound(rawEvent) {
    const accountId = rawEvent?.accountId ?? this.resolveImplicitAccountId();
    const update = rawEvent?.update ?? rawEvent;
    const state = await this.ensureAccountState(accountId);
    if (!state) return [];
    await this.ensureBotProfile(state.accountId);
    return telegramUpdateToInbound(update, {
      accountId: state.accountId,
      api: state.api,
      dataDir: this.dataDir,
      botUsername: state.botProfile?.username
    });
  }

  async send(outboundMessage) {
    try {
      const accountId = outboundMessage.accountId ?? outboundMessage.conversationRef?.accountId ?? this.resolveImplicitAccountId();
      const state = await this.ensureAccountState(accountId);
      if (!state) {
        throw new CrewlineError({
          code: ErrorCodes.CHANNEL_UNAVAILABLE,
          layer: 'channel',
          recoverable: false,
          message: `Telegram account not active: ${accountId ?? 'unknown'}`
        });
      }
      if (outboundMessage.meta?.streamChunks && typeof state.api.streamText === 'function') {
        const fallbackThreadId = outboundMessage.meta?.telegram?.messageThreadId;
        return await state.api.streamText({
          chatId: outboundMessage.conversationRef.conversationId,
          messageThreadId: outboundMessage.conversationRef.topicId
            ? Number(outboundMessage.conversationRef.topicId)
            : fallbackThreadId,
          chunks: outboundMessage.meta.streamChunks,
          initialText: outboundMessage.meta.initialText,
          replyTo: outboundMessage.replyTo,
          meta: outboundMessage.meta.telegram ?? {}
        });
      }
      if (outboundMessage.meta?.patchMessageId) {
        const mapped = outboundToTelegramSendRequest(outboundMessage);
        const chatId = mapped.conversationRef.conversationId;
        const fallbackThreadId = mapped.meta?.telegram?.messageThreadId;
        const messageThreadId = mapped.conversationRef.topicId
          ? Number(mapped.conversationRef.topicId)
          : fallbackThreadId;
        const apiMeta = mapped.meta?.parse_mode ? { parse_mode: mapped.meta.parse_mode } : undefined;
        const parts = splitText(mapped.text);
        await state.api.editMessageText({
          chatId,
          messageId: outboundMessage.meta.patchMessageId,
          messageThreadId,
          text: parts[0],
          meta: apiMeta
        });
        for (let i = 1; i < parts.length; i++) {
          await state.api.sendMessage({
            chatId,
            messageThreadId,
            text: parts[i],
            meta: apiMeta
          });
        }
        return { messageId: outboundMessage.meta.patchMessageId };
      }
      return await sendTelegramMessage(state.api, outboundToTelegramSendRequest(outboundMessage));
    } catch (error) {
      throw new CrewlineError({
        code: ErrorCodes.CHANNEL_SEND_FAILED,
        layer: 'channel',
        recoverable: true,
        message: 'Failed to send Telegram message',
        cause: error
      });
    }
  }

  async healthcheck() {
    return {
      ok: true,
      channel: 'telegram',
      accounts: this.getResolvedAccounts().map((account) => account.accountId)
    };
  }
}
