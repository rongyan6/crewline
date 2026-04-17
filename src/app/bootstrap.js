import { createLogger } from '../obs/logger.js';
import { Metrics } from '../obs/metrics.js';
import { AuditTrail } from '../obs/audit.js';
import { ChannelPluginHost } from '../channel/host/channel-plugin-host.js';
import { conversationLogPath, runtimeBindingPath } from '../channel/host/conversation-ref.js';
import { TelegramNativePlugin } from '../channel/telegram/telegram-plugin.js';
import { FeishuChannelPlugin } from '../channel/feishu/feishu-plugin.js';
import { WechatChannelPlugin } from '../channel/wechat/wechat-plugin.js';
import { createOutboundMessage } from '../channel/host/outbound-message.js';
import { startHeartbeat } from '../shared/utils/heartbeat.js';
import { AsyncTextStream } from '../shared/utils/async-text-stream.js';
import { formatLocalTimestamp } from '../shared/utils/time.js';
import path from 'node:path';
import { AgentRegistry } from '../core/agents/agent-registry.js';
import { ConversationRouter } from '../core/router/conversation-router.js';
import { AcpxClient } from '../runtime/acp/acpx-client.js';
import { AcpRuntimeGateway } from '../runtime/acp/runtime-gateway.js';
import { ConversationLog } from '../state/store/conversation-log.js';
import { RuntimeBindingStore } from '../state/store/runtime-binding-store.js';
import { StateStore } from '../state/store/state-store.js';
import { SessionManager } from '../core/session/session-manager.js';
import { handleAdminCommand } from '../admin/admin-service.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasKeys(value = {}) {
  return Object.keys(value).length > 0;
}

function normalizeAttachments(attachments = []) {
  return attachments.map((attachment) => ({
    kind: attachment.kind ?? 'file',
    localPath: attachment.localPath ?? null,
    fileName: attachment.fileName ?? null,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.fileSize ?? null
  }));
}

function buildLogError({ code, message, layer } = {}) {
  if (!code && !message && !layer) return null;
  return {
    code: code ?? null,
    message: message ?? null,
    layer: layer ?? null
  };
}

function resolveTelegramRequireMention(config, conversationRef) {
  if (conversationRef.scope === 'topic') {
    const topicKey = `${conversationRef.conversationId}:${conversationRef.topicId ?? conversationRef.participantId ?? ''}`;
    const topicConfig = config?.topics?.[topicKey];
    if (topicConfig?.requireMention !== undefined) {
      return topicConfig.requireMention === true;
    }
    return config?.requireMention?.topic === true;
  }
  if (conversationRef.scope === 'group') {
    const groupConfig = config?.groups?.[conversationRef.conversationId];
    if (groupConfig?.requireMention !== undefined) {
      return groupConfig.requireMention === true;
    }
    return config?.requireMention?.group === true;
  }
  return false;
}

function isSimpleWechatGreeting(text = '') {
  const normalized = String(text).trim().toLowerCase();
  return [
    'hi',
    'hello',
    'hey',
    'ping',
    '你好',
    '嗨',
    '在吗',
    '在么'
  ].includes(normalized);
}

function formatAgentDisplayName(agentName = '') {
  const normalized = String(agentName).trim().toLowerCase();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function buildTelegramReplyMeta(inboundMessage, extra = {}) {
  if (inboundMessage?.channel !== 'telegram') return extra;
  if (Object.keys(extra).length === 0) return undefined;
  return extra;
}

function buildInlineReplyTarget(inboundMessage) {
  if (!inboundMessage?.messageId) return undefined;
  if (inboundMessage.channel === 'telegram' || inboundMessage.channel === 'feishu') {
    return inboundMessage.messageId;
  }
  return undefined;
}

function buildFirstSessionGreeting({ routeDecision }) {
  return [
    '新会话已启动。',
    `当前 Agent：${formatAgentDisplayName(routeDecision.agentName)} (${routeDecision.instanceId})`,
    `工作目录：${routeDecision.resolvedCwd}`,
    '直接发任务即可，我会开始处理。'
  ].join('\n');
}

function parseSessionCommand(text = '') {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (/^\/reset(?:@[a-z0-9_]+)?$/i.test(tokens[0])) {
    return {
      raw: tokens[0],
      name: 'reset',
      args: tokens.slice(1)
    };
  }
  return null;
}

function buildSessionResetReply({ routeDecision }) {
  return [
    '已重置当前 Agent 会话。',
    `当前 Agent：${formatAgentDisplayName(routeDecision.agentName)} (${routeDecision.instanceId})`,
    '聊天记录和绑定保持不变，后续消息会进入新的 Agent 会话。'
  ].join('\n');
}

function resolveTelegramGroupAllowFrom(config, conversationRef) {
  if (conversationRef.scope === 'topic') {
    const topicKey = `${conversationRef.conversationId}:${conversationRef.topicId ?? conversationRef.participantId ?? ''}`;
    const topicConfig = config?.topics?.[topicKey];
    return topicConfig?.groupAllowFrom?.length
      ? topicConfig.groupAllowFrom
      : (config?.groupAllowFrom ?? []);
  }
  if (conversationRef.scope === 'group') {
    const groupConfig = config?.groups?.[conversationRef.conversationId];
    return groupConfig?.groupAllowFrom?.length
      ? groupConfig.groupAllowFrom
      : (config?.groupAllowFrom ?? []);
  }
  return [];
}

function createConversationLogger({ stateStore, timezone }) {
  return async ({ inboundMessage, role, text, messageId = null, attachments = [], error = null, meta = {} }) => {
    await stateStore.conversationLog.append({
      path: conversationLogPath({
        dataDir: stateStore.dataDir,
        conversationRef: inboundMessage.conversationRef
      }),
      at: formatLocalTimestamp(role === 'user' ? inboundMessage.timestamp : new Date(), timezone),
      timezone,
      channel: inboundMessage.channel,
      scope: inboundMessage.conversationRef.scope,
      conversationId: inboundMessage.conversationRef.conversationId,
      participantId: inboundMessage.conversationRef.participantId,
      topicId: inboundMessage.conversationRef.topicId ?? null,
      accountId: inboundMessage.accountId ?? 'default',
      messageId,
      role,
      text,
      attachments,
      error,
      meta
    });
  };
}

export async function bootstrap({ config, telegramApi, runtimeClient, feishuSdk } = {}) {
  const logger = createLogger();
  const timezone = config.runtime?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const metrics = new Metrics({
    filePath: path.join(config.runtime.dataDir, 'metrics', 'events.jsonl'),
    snapshotPath: path.join(config.runtime.dataDir, 'metrics', 'snapshot.json')
  });
  const audit = new AuditTrail({
    filePath: path.join(config.runtime.dataDir, 'audit', 'events.jsonl')
  });
  const channelHost = new ChannelPluginHost({ logger });
  const telegramConfig = config.channel?.telegram ?? config.telegram;
  const telegramAccountSecrets = config.secrets?.telegramAccounts ?? {};
  const shouldEnableTelegram = Boolean(
    (
      telegramApi ||
      config.secrets?.telegramBotToken ||
      telegramConfig?.botToken ||
      Object.values(telegramAccountSecrets).some((account) => account?.botToken) ||
      Object.values(telegramConfig?.accounts ?? {}).some((account) => account?.botToken || account?.token)
    )
  );
  const telegramPlugin = shouldEnableTelegram
    ? channelHost.register(new TelegramNativePlugin({
        api: telegramApi,
        config: telegramConfig,
        logger,
        dataDir: config.runtime.dataDir,
        secrets: {
          telegramBotToken: config.secrets?.telegramBotToken,
          telegramAccounts: telegramAccountSecrets
        }
      }))
    : null;
  const feishuConfig = config.channel?.feishu ?? config.feishu;
  const feishuAccountSecrets = config.secrets?.feishuAccounts ?? {};
  const shouldEnableFeishu = Boolean(
    feishuConfig?.enabled !== false &&
    (
      (config.secrets?.feishuAppId && config.secrets?.feishuAppSecret) ||
      Object.values(feishuAccountSecrets).some((account) => account?.appId && account?.appSecret)
    )
  );
  const feishuPlugin = shouldEnableFeishu
    ? channelHost.register(new FeishuChannelPlugin({
        config: feishuConfig,
        logger,
        secrets: {
          appId: config.secrets?.feishuAppId,
          appSecret: config.secrets?.feishuAppSecret,
          feishuAccounts: config.secrets?.feishuAccounts
        },
        sdk: feishuSdk,
        dataDir: config.runtime.dataDir
      }))
    : null;
  const wechatConfig = config.channel?.wechat ?? config.wechat;
  const wechatBindings = config.bindings?.wechat ?? {};
  const shouldEnableWechat = Boolean(
    wechatConfig?.enabled === true &&
    (
      hasKeys(wechatBindings.dm) ||
      Object.values(wechatBindings.accounts ?? {}).some((bindings) => hasKeys(bindings?.dm))
    )
  );
  const wechatPlugin = shouldEnableWechat
    ? channelHost.register(new WechatChannelPlugin({
        config: wechatConfig,
        logger,
        dataDir: config.runtime.dataDir
      }))
    : null;
  const agentRegistry = new AgentRegistry(config.agents);
  const router = new ConversationRouter({ bindings: config.bindings, agentRegistry });
  const runtimeGateway = new AcpRuntimeGateway({
    client: runtimeClient ?? new AcpxClient({
      turnTimeoutMs: config.runtime?.acpxTurnTimeoutMs
    })
  });
  const stateStore = new StateStore({
    dataDir: config.runtime.dataDir,
    runtimeBindingStore: new RuntimeBindingStore((conversationRef) =>
      runtimeBindingPath({ dataDir: config.runtime.dataDir, conversationRef })
    ),
    conversationLog: new ConversationLog()
  });
  const sessionManager = new SessionManager({
    stateStore,
    runtimeGateway,
    sessionPolicy: config.session
  });
  const appendConversationLog = createConversationLogger({ stateStore, timezone });
  const telegramTypingStartDelayMs = config.runtime?.telegramTypingStartDelayMs ?? 0;
  const telegramTypingIntervalMs = config.runtime?.telegramTypingIntervalMs ?? 4500;
  const feishuTypingMinVisibleMs = config.runtime?.feishuTypingMinVisibleMs ?? 1200;
  const wechatTypingMinVisibleMs = config.runtime?.wechatTypingMinVisibleMs ?? 1200;
  let inFlightTurns = 0;
  const idleWaiters = new Set();

  function settleIdleWaiters() {
    if (inFlightTurns !== 0) return;
    for (const waiter of idleWaiters) waiter();
    idleWaiters.clear();
  }

  async function waitForIdle(timeoutMs = 10_000) {
    if (inFlightTurns === 0) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        idleWaiters.delete(onIdle);
        resolve(false);
      }, timeoutMs);
      const onIdle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      idleWaiters.add(onIdle);
    });
  }

  const handleInboundMessage = async (inboundMessage) => {
    inFlightTurns += 1;
    const isSyntheticTrigger = inboundMessage.rawMeta?.syntheticTrigger === true;
    const telegramAccountConfig = inboundMessage.channel === 'telegram'
      ? (telegramPlugin?.getAccountConfig(inboundMessage.accountId) ?? telegramConfig)
      : null;
    logger.info('[crewline.inbound]', {
      channel: inboundMessage.channel,
      messageId: inboundMessage.messageId ?? null,
      scope: inboundMessage.conversationRef.scope,
      conversationId: inboundMessage.conversationRef.conversationId,
      senderId: inboundMessage.senderRef.userId,
      text: inboundMessage.text,
      source: isSyntheticTrigger ? 'synthetic-trigger' : 'channel'
    });
    await metrics.increment('messages.inbound', 1, {
      channel: inboundMessage.channel,
      scope: inboundMessage.conversationRef.scope
    });
    await audit.record({
      event: 'message.inbound',
      channel: inboundMessage.channel,
      scope: inboundMessage.conversationRef.scope,
      conversationId: inboundMessage.conversationRef.conversationId,
      messageId: inboundMessage.messageId
    });
    await appendConversationLog({
      inboundMessage,
      role: 'user',
      text: inboundMessage.text,
      messageId: inboundMessage.messageId,
      attachments: normalizeAttachments(inboundMessage.rawMeta?.attachments),
      error: inboundMessage.rawMeta?.attachments?.find((attachment) => attachment.downloadError)
        ? buildLogError({
            code: 'ATTACHMENT_DOWNLOAD_FAILED',
            message: inboundMessage.rawMeta.attachments.find((attachment) => attachment.downloadError)?.downloadError,
            layer: 'channel'
          })
        : null,
      meta: { source: isSyntheticTrigger ? 'synthetic-trigger' : 'channel' }
    });

    if (!isSyntheticTrigger) {
      const adminResult = await handleAdminCommand({
        inboundMessage,
        config,
        live: {
          runtimeHome: config.runtime?.dataDir,
          channelHost,
          runtimeGateway,
          stateStore,
          metrics
        }
      });
      if (adminResult?.handled) {
        if (adminResult.suppressReply === true) {
          logger.info('[crewline.admin.duplicate]', {
            channel: inboundMessage.channel,
            messageId: inboundMessage.messageId ?? null,
            conversationId: inboundMessage.conversationRef.conversationId,
            command: inboundMessage.text
          });
          return { inboundMessage, localReply: false, adminCommand: true, duplicate: true };
        }
        const sendResult = await channelHost.send(createOutboundMessage({
          channel: inboundMessage.channel,
          accountId: inboundMessage.accountId,
          conversationRef: inboundMessage.conversationRef,
          text: adminResult.text,
          replyTo: buildInlineReplyTarget(inboundMessage),
          meta: buildTelegramReplyMeta(inboundMessage)
        }));
        await appendConversationLog({
          inboundMessage,
          role: 'system',
          text: adminResult.text,
          messageId: sendResult?.messageId ?? null,
          attachments: [],
          error: null,
          meta: {
            reason: 'admin-command',
            command: inboundMessage.text,
            sourceMessageId: inboundMessage.messageId ?? null
          }
        });
        await metrics.increment('messages.local_reply', 1, {
          channel: inboundMessage.channel,
          scope: inboundMessage.conversationRef.scope
        });
        await audit.record({
          event: 'message.local_reply',
          channel: inboundMessage.channel,
          scope: inboundMessage.conversationRef.scope,
          conversationId: inboundMessage.conversationRef.conversationId,
          reason: 'admin-command'
        });
        await adminResult.postSendAction?.();
        return { inboundMessage, localReply: true, adminCommand: true, sendResult };
      }
    }

    if (typeof inboundMessage.rawMeta?.localReplyText === 'string' && inboundMessage.rawMeta.localReplyText) {
      const sendResult = await channelHost.send(createOutboundMessage({
        channel: inboundMessage.channel,
        accountId: inboundMessage.accountId,
        conversationRef: inboundMessage.conversationRef,
        text: inboundMessage.rawMeta.localReplyText,
        replyTo: buildInlineReplyTarget(inboundMessage),
        meta: buildTelegramReplyMeta(inboundMessage)
      }));
      await appendConversationLog({
        inboundMessage,
        role: 'system',
        text: inboundMessage.rawMeta.localReplyText,
        messageId: sendResult?.messageId ?? null,
        attachments: [],
        error: buildLogError({
          code: 'LOCAL_REPLY',
          message: inboundMessage.rawMeta.attachments?.length ? 'Media handling fallback reply' : 'Unsupported message fallback reply',
          layer: 'channel'
        }),
        meta: {
          reason: inboundMessage.rawMeta.attachments?.length ? 'media-local-handling' : 'unsupported-message'
        }
      });
      logger.info('[crewline.local-reply]', {
        conversationId: inboundMessage.conversationRef.conversationId,
        scope: inboundMessage.conversationRef.scope,
        reason: inboundMessage.rawMeta.attachments?.length ? 'media-local-handling' : 'unsupported-message'
      });
      await metrics.increment('messages.local_reply', 1, {
        channel: inboundMessage.channel,
        scope: inboundMessage.conversationRef.scope
      });
      await audit.record({
        event: 'message.local_reply',
        channel: inboundMessage.channel,
        scope: inboundMessage.conversationRef.scope,
        conversationId: inboundMessage.conversationRef.conversationId,
        reason: inboundMessage.rawMeta.attachments?.length ? 'media-local-handling' : 'unsupported-message'
      });
      return { inboundMessage, localReply: true, sendResult };
    }

    if (!isSyntheticTrigger && isSimpleWechatGreeting(inboundMessage.text)) {
      const userTurnCount = await stateStore.conversationLog.countRole(
        conversationLogPath({
          dataDir: stateStore.dataDir,
          conversationRef: inboundMessage.conversationRef
        }),
        'user'
      );
      if (userTurnCount === 1) {
        const routeDecision = router.route(inboundMessage);
        const session = await sessionManager.getOrCreateSession(routeDecision);
        const quickReply = buildFirstSessionGreeting({ routeDecision, session });
        const sendResult = await channelHost.send(createOutboundMessage({
          channel: inboundMessage.channel,
          accountId: inboundMessage.accountId,
          conversationRef: inboundMessage.conversationRef,
          text: quickReply,
          replyTo: buildInlineReplyTarget(inboundMessage),
          meta: buildTelegramReplyMeta(inboundMessage)
        }));
        await appendConversationLog({
          inboundMessage,
          role: 'system',
          text: quickReply,
          messageId: sendResult?.messageId ?? null,
          attachments: [],
          error: null,
          meta: {
            reason: 'first-session-greeting-fast-path',
            sessionId: session.sessionId,
            instanceId: routeDecision.instanceId
          }
        });
        await metrics.increment('messages.local_reply', 1, {
          channel: inboundMessage.channel,
          scope: inboundMessage.conversationRef.scope
        });
        await audit.record({
          event: 'message.local_reply',
          channel: inboundMessage.channel,
          scope: inboundMessage.conversationRef.scope,
          conversationId: inboundMessage.conversationRef.conversationId,
          reason: 'first-session-greeting-fast-path'
        });
        return { inboundMessage, localReply: true, sendResult, routeDecision, session };
      }
    }

    if (inboundMessage.channel === 'telegram' && !isSyntheticTrigger) {
      if (inboundMessage.conversationRef.scope === 'group' || inboundMessage.conversationRef.scope === 'topic') {
        const groupAllowFrom = resolveTelegramGroupAllowFrom(telegramAccountConfig, inboundMessage.conversationRef);
        if (!groupAllowFrom.includes(String(inboundMessage.senderRef.userId))) {
          logger.info('[crewline.telegram.gate]', {
            conversationId: inboundMessage.conversationRef.conversationId,
            scope: inboundMessage.conversationRef.scope,
            senderId: inboundMessage.senderRef.userId,
            reason: 'sender_not_allowed'
          });
          await metrics.increment('messages.gated', 1, {
            channel: inboundMessage.channel,
            scope: inboundMessage.conversationRef.scope
          });
          return {
            inboundMessage,
            gated: true
          };
        }
      }

      const requireMention = resolveTelegramRequireMention(telegramAccountConfig, inboundMessage.conversationRef);
      if (requireMention && inboundMessage.rawMeta?.botMentioned !== true) {
        logger.info('[crewline.telegram.gate]', {
          conversationId: inboundMessage.conversationRef.conversationId,
          scope: inboundMessage.conversationRef.scope,
          reason: 'mention_required'
        });
        await metrics.increment('messages.gated', 1, {
          channel: inboundMessage.channel,
          scope: inboundMessage.conversationRef.scope
        });
        return {
          inboundMessage,
          gated: true
        };
      }
    }

    const sessionCommand = !isSyntheticTrigger ? parseSessionCommand(inboundMessage.text) : null;
    const routeDecision = router.route(inboundMessage);
    if (sessionCommand?.name === 'reset') {
      let replyText = '/reset 不接受参数，直接发送 /reset 即可。';
      let session = null;
      if (sessionCommand.args.length === 0) {
        session = await sessionManager.resetSession(routeDecision);
        replyText = buildSessionResetReply({ routeDecision });
      }
      const sendResult = await channelHost.send(createOutboundMessage({
        channel: inboundMessage.channel,
        accountId: inboundMessage.accountId,
        conversationRef: inboundMessage.conversationRef,
        text: replyText,
        replyTo: buildInlineReplyTarget(inboundMessage),
        meta: buildTelegramReplyMeta(inboundMessage)
      }));
      await appendConversationLog({
        inboundMessage,
        role: 'system',
        text: replyText,
        messageId: sendResult?.messageId ?? null,
        attachments: [],
        error: null,
        meta: {
          reason: 'session-command',
          command: sessionCommand.raw,
          sessionId: session?.sessionId ?? null,
          instanceId: routeDecision.instanceId
        }
      });
      await metrics.increment('messages.local_reply', 1, {
        channel: inboundMessage.channel,
        scope: inboundMessage.conversationRef.scope
      });
      await audit.record({
        event: 'message.local_reply',
        channel: inboundMessage.channel,
        scope: inboundMessage.conversationRef.scope,
        conversationId: inboundMessage.conversationRef.conversationId,
        reason: 'session-command'
      });
      return { inboundMessage, localReply: true, sessionCommand: true, sendResult, routeDecision, session };
    }

    let stopTyping = null;
    const streamStartedAt = Date.now();
    let firstChunkAt = null;
    const streamChunks = [];
    const shouldLiveStream = inboundMessage.channel === 'feishu'
      ? feishuConfig?.streaming === true
      : inboundMessage.channel === 'telegram' && telegramAccountConfig?.streaming === true;
    const liveStream = shouldLiveStream ? new AsyncTextStream() : null;
    let liveSendPromise = null;
    let liveSendError = null;
    let liveSendErrorLogged = false;

    const ensureLiveSend = () => {
      if (!shouldLiveStream || liveSendPromise) return;
      liveSendPromise = channelHost.send(createOutboundMessage({
        channel: inboundMessage.channel,
        accountId: inboundMessage.accountId,
        conversationRef: inboundMessage.conversationRef,
        text: '',
        meta: inboundMessage.channel === 'feishu'
          ? {
              streamChunks: liveStream,
              elapsedMs: Date.now() - streamStartedAt
            }
          : buildTelegramReplyMeta(inboundMessage, {
              streamChunks: liveStream,
              telegram: {
                debounceMs: 400,
                minCharsBeforeFirstSend: 16,
                minCharsPerEdit: 80
              }
            })
      })).catch((error) => {
        liveSendError = error;
        return null;
      });
    };

    try {
      if (inboundMessage.channel === 'feishu' && liveStream) {
        ensureLiveSend();
      }

      if (inboundMessage.channel === 'telegram') {
        const topicId = inboundMessage.conversationRef.topicId;
        const chatIsForum = inboundMessage.rawMeta?.chatIsForum === true;
        const typingThreadId = topicId ? Number(topicId)
          : chatIsForum ? 1  // General topic in forum groups
          : undefined;
        const telegramApiForAccount = await telegramPlugin?.getAccountApi(inboundMessage.accountId);
        const sendTypingAction = async () => {
          if (!telegramApiForAccount?.sendChatAction) return;
          await telegramApiForAccount.sendChatAction({
            chatId: inboundMessage.conversationRef.conversationId,
            action: 'typing',
            messageThreadId: typingThreadId
          });
          logger.debug?.('[crewline.typing] sent typing action');
        };
        const sendTypingActionSafely = async () => {
          try {
            await sendTypingAction();
          } catch (error) {
            logger.warn('[crewline.typing.failed]', {
              conversationKey: routeDecision.conversationKey,
              error: error?.message ?? String(error)
            });
          }
        };

        if (telegramTypingStartDelayMs === 0) {
          void sendTypingActionSafely();
        }

        const heartbeat = startHeartbeat(sendTypingActionSafely, {
          startDelayMs: telegramTypingStartDelayMs === 0 ? telegramTypingIntervalMs : telegramTypingStartDelayMs,
          intervalMs: telegramTypingIntervalMs
        });
        stopTyping = async () => {
          heartbeat.stop();
        };
      }

      if (inboundMessage.channel === 'wechat' && wechatPlugin) {
        const typingStartedAt = Date.now();
        const stopWechatTyping = await wechatPlugin.createTypingSession(inboundMessage);
        if (stopWechatTyping) {
          stopTyping = async () => {
            const remainingVisibleMs = wechatTypingMinVisibleMs - (Date.now() - typingStartedAt);
            if (remainingVisibleMs > 0) {
              await delay(remainingVisibleMs);
            }
            await stopWechatTyping();
          };
        }
      }

      if (inboundMessage.channel === 'feishu' && inboundMessage.messageId && feishuPlugin) {
        let typingStopped = false;
        const typingStatePromise = (async () => {
          try {
            const accountState = await feishuPlugin.ensureAccountState(inboundMessage.accountId ?? 'default');
            const messageReaction = accountState?.client?.im?.messageReaction;
            if (!messageReaction?.create || !messageReaction?.delete) return null;
            const response = await messageReaction.create({
              path: {
                message_id: inboundMessage.messageId
              },
              data: {
                reaction_type: {
                  emoji_type: 'Typing'
                }
              }
            });
            const state = {
              messageId: inboundMessage.messageId,
              reactionId: response?.data?.reaction_id ?? null,
              createdAt: Date.now(),
              messageReaction
            };
            if (typingStopped && state.reactionId) {
              await state.messageReaction.delete({
                path: {
                  message_id: state.messageId,
                  reaction_id: state.reactionId
                }
              });
            }
            return state;
          } catch (error) {
            logger.debug?.('[crewline.feishu.typing]', {
              messageId: inboundMessage.messageId,
              error: error?.message ?? String(error)
            });
            return null;
          }
        })();

        stopTyping = async () => {
          typingStopped = true;
          try {
            const state = await typingStatePromise;
            if (!state?.reactionId) return;
            const remainingVisibleMs = feishuTypingMinVisibleMs - (Date.now() - state.createdAt);
            if (remainingVisibleMs > 0) {
              await delay(remainingVisibleMs);
            }
            await state.messageReaction.delete({
              path: {
                message_id: state.messageId,
                reaction_id: state.reactionId
              }
            });
          } catch (error) {
            logger.debug?.('[crewline.feishu.typing.cleanup]', {
              messageId: inboundMessage.messageId,
              error: error?.message ?? String(error)
            });
          }
        };
      }

      const turnStartedAt = Date.now();
      const { session, result } = await sessionManager.runTurn({
        inboundMessage,
        routeDecision,
        onChunk: (chunk) => {
          firstChunkAt ??= Date.now();
          streamChunks.push(chunk);
          if (liveStream) {
            ensureLiveSend();
            liveStream.push(chunk);
          }
          logger.debug?.('[crewline.stream.chunk]', {
            conversationKey: routeDecision.conversationKey,
            size: chunk.length
          });
        }
      });

      logger.info('[crewline.timing]', {
        conversationKey: routeDecision.conversationKey,
        runtimeMs: result.latencyMs ?? null,
        timeToFirstChunkMs: firstChunkAt ? firstChunkAt - turnStartedAt : null,
        typingVisibleDelayMs: 0,
        turnMs: Date.now() - turnStartedAt,
        totalMs: Date.now() - streamStartedAt
      });
      await metrics.timing('turn.total_ms', Date.now() - turnStartedAt, {
        channel: inboundMessage.channel,
        scope: inboundMessage.conversationRef.scope,
        outcome: result.ok ? 'ok' : 'error'
      });

      await stopTyping?.();
      stopTyping = null;

      const outboundStartedAt = Date.now();
      if (result.ok && result.outputText) {
        if (liveStream) liveStream.close();
        let sendResult = null;
        if (liveSendPromise) {
          const liveResult = await liveSendPromise;
          if (liveSendError && !liveSendErrorLogged) {
            logger.warn('[crewline.stream.failed]', {
              conversationKey: routeDecision.conversationKey,
              error: liveSendError?.message ?? String(liveSendError)
            });
            liveSendErrorLogged = true;
          }
          if (inboundMessage.channel === 'feishu') {
            sendResult = await channelHost.send(createOutboundMessage({
              channel: inboundMessage.channel,
              accountId: inboundMessage.accountId,
              conversationRef: inboundMessage.conversationRef,
              text: result.outputText,
              meta: {
                patchMessageId: liveResult?.messageId ?? null,
                elapsedMs: Date.now() - streamStartedAt
              }
            }));
          } else if (inboundMessage.channel === 'telegram') {
            if (liveResult?.messageId && liveResult.text?.trim() === result.outputText?.trim()) {
              sendResult = liveResult;
            }
            // Otherwise leave sendResult null — fallback will send the full text as a new message.
            // This avoids truncated output when streaming edits or patches fail due to proxy issues.
          } else {
            sendResult = liveResult;
          }
        }
        sendResult ??= await channelHost.send(createOutboundMessage({
          channel: inboundMessage.channel,
          accountId: inboundMessage.accountId,
          conversationRef: inboundMessage.conversationRef,
          text: result.outputText,
          meta: inboundMessage.channel === 'feishu'
            ? {
                elapsedMs: Date.now() - streamStartedAt
              }
            : buildTelegramReplyMeta(inboundMessage)
        }));
        await appendConversationLog({
          inboundMessage,
          role: 'assistant',
          text: result.outputText,
          messageId: sendResult?.messageId ?? null,
          attachments: [],
          error: null,
          meta: {
            sessionId: session.sessionId,
            instanceId: routeDecision.instanceId
          }
        });
        await metrics.increment('messages.outbound', 1, {
          channel: inboundMessage.channel,
          scope: inboundMessage.conversationRef.scope,
          role: 'assistant'
        });
        if (inboundMessage.channel === 'wechat' && wechatPlugin?.isDebugMode(inboundMessage.accountId)) {
          const debugText = [
            '⏱ Debug 全链路',
            `├ 平台→插件: ${Date.now() - new Date(inboundMessage.timestamp).getTime()}ms`,
            `├ AI生成+回复: ${Date.now() - turnStartedAt}ms`,
            `├ 输出长度: ${result.outputText.length}`,
            `└ eventTime: ${inboundMessage.timestamp}`
          ].join('\n');
          const debugSendResult = await channelHost.send(createOutboundMessage({
            channel: inboundMessage.channel,
            accountId: inboundMessage.accountId,
            conversationRef: inboundMessage.conversationRef,
            text: debugText,
            meta: buildTelegramReplyMeta(inboundMessage)
          }));
          await appendConversationLog({
            inboundMessage,
            role: 'system',
            text: debugText,
            messageId: debugSendResult?.messageId ?? null,
            attachments: [],
            error: null,
            meta: {
              reason: 'wechat-debug-timing'
            }
          });
        }
        await audit.record({
          event: 'message.outbound',
          channel: inboundMessage.channel,
          scope: inboundMessage.conversationRef.scope,
          conversationId: inboundMessage.conversationRef.conversationId,
          sessionId: session.sessionId,
          outcome: 'ok'
        });
      } else if (!result.ok) {
        if (liveStream) liveStream.close();
        const failureText = result.errorMessage ?? '当前会话执行失败。';
        let sendResult = null;
        if (liveSendPromise) {
          const liveResult = await liveSendPromise;
          if (liveSendError && !liveSendErrorLogged) {
            logger.warn('[crewline.stream.failed]', {
              conversationKey: routeDecision.conversationKey,
              error: liveSendError?.message ?? String(liveSendError)
            });
            liveSendErrorLogged = true;
          }
          if (inboundMessage.channel === 'feishu' && liveResult?.messageId) {
            sendResult = await channelHost.send(createOutboundMessage({
              channel: inboundMessage.channel,
              accountId: inboundMessage.accountId,
              conversationRef: inboundMessage.conversationRef,
              text: failureText,
              meta: {
                patchMessageId: liveResult.messageId,
                elapsedMs: Date.now() - streamStartedAt,
                statusText: '执行失败'
              }
            }));
          }
        }
        sendResult ??= await channelHost.send(createOutboundMessage({
          channel: inboundMessage.channel,
          accountId: inboundMessage.accountId,
          conversationRef: inboundMessage.conversationRef,
          text: failureText,
          meta: inboundMessage.channel === 'feishu'
            ? { elapsedMs: Date.now() - streamStartedAt }
            : buildTelegramReplyMeta(inboundMessage)
        }));
        await appendConversationLog({
          inboundMessage,
          role: 'system',
          text: failureText,
          messageId: sendResult?.messageId ?? null,
          attachments: [],
          error: buildLogError({
            code: result.errorCode,
            message: result.errorMessage,
            layer: 'runtime'
          }),
          meta: {
            sessionId: session.sessionId,
            instanceId: routeDecision.instanceId
          }
        });
        await metrics.increment('messages.error_reply', 1, {
          channel: inboundMessage.channel,
          scope: inboundMessage.conversationRef.scope
        });
        await audit.record({
          event: 'message.outbound',
          channel: inboundMessage.channel,
          scope: inboundMessage.conversationRef.scope,
          conversationId: inboundMessage.conversationRef.conversationId,
          sessionId: session.sessionId,
          outcome: 'error',
          errorCode: result.errorCode ?? null
        });
      }
      logger.info('[crewline.delivery]', {
        conversationKey: routeDecision.conversationKey,
        sendMs: Date.now() - outboundStartedAt,
        totalMs: Date.now() - streamStartedAt
      });
      if (result.ok && result.outputText) {
        logger.info('[crewline.outbound]', {
          conversationKey: routeDecision.conversationKey,
          sessionId: session.sessionId,
          instanceId: routeDecision.instanceId,
          text: result.outputText
        });
      }
      return { inboundMessage, routeDecision, session, result };
    } finally {
      if (liveStream) liveStream.close();
      await stopTyping?.();
      inFlightTurns -= 1;
      settleIdleWaiters();
    }
  };
  channelHost.setInboundHandler(handleInboundMessage);

  async function triggerInbound({ inboundMessage, noticeText }) {
    const visibleText = String(noticeText ?? inboundMessage?.text ?? '').trim();
    if (!visibleText) {
      throw new Error('triggerInbound requires noticeText or inboundMessage.text');
    }
    logger.info('[crewline.trigger]', {
      channel: inboundMessage.channel,
      conversationId: inboundMessage.conversationRef.conversationId,
      scope: inboundMessage.conversationRef.scope,
      messageId: inboundMessage.messageId ?? null
    });
    const sendResult = await channelHost.send(createOutboundMessage({
      channel: inboundMessage.channel,
      accountId: inboundMessage.accountId,
      conversationRef: inboundMessage.conversationRef,
      text: visibleText,
      meta: buildTelegramReplyMeta(inboundMessage)
    }));
    await appendConversationLog({
      inboundMessage,
      role: 'system',
      text: visibleText,
      messageId: sendResult?.messageId ?? null,
      attachments: [],
      error: null,
      meta: {
        reason: 'trigger-notice',
        source: 'synthetic-trigger',
        sourceMessageId: inboundMessage.messageId ?? null
      }
    });
    await metrics.increment('messages.outbound', 1, {
      channel: inboundMessage.channel,
      scope: inboundMessage.conversationRef.scope,
      role: 'system'
    });
    await audit.record({
      event: 'message.outbound',
      channel: inboundMessage.channel,
      scope: inboundMessage.conversationRef.scope,
      conversationId: inboundMessage.conversationRef.conversationId,
      messageId: sendResult?.messageId ?? null,
      outcome: 'ok',
      reason: 'trigger-notice'
    });
    const triggerResult = await handleInboundMessage(inboundMessage);
    return {
      noticeSendResult: sendResult,
      triggerResult
    };
  }

  return {
    logger,
    metrics,
    audit,
    channelHost,
    telegramPlugin,
    feishuPlugin,
    wechatPlugin,
    agentRegistry,
    router,
    runtimeGateway,
    stateStore,
    sessionManager,
    waitForIdle,
    handleInboundMessage,
    triggerInbound
  };
}
