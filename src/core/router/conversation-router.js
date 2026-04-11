import { buildConversationKey } from '../../channel/host/conversation-ref.js';
import { createRouteDecision } from './route-decision.js';
import { CrewlineError } from '../../shared/errors/error-envelope.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';

function resolveTelegramBinding(bindings, conversationRef) {
  const telegram = bindings.telegram ?? {};
  const accountBindings = telegram.accounts?.[conversationRef.accountId ?? 'default'] ?? null;
  const canFallbackToLegacy = Object.keys(telegram.accounts ?? {}).length <= 1;
  if (conversationRef.scope === 'dm') {
    return accountBindings?.dm?.[conversationRef.participantId]
      ?? (canFallbackToLegacy ? telegram.dm?.[conversationRef.participantId] : null)
      ?? null;
  }
  if (conversationRef.scope === 'group') {
    return accountBindings?.group?.[conversationRef.conversationId]
      ?? (canFallbackToLegacy ? telegram.group?.[conversationRef.conversationId] : null)
      ?? null;
  }
  if (conversationRef.scope === 'topic') {
    const topicKey = `${conversationRef.conversationId}:${conversationRef.topicId ?? conversationRef.participantId}`;
    return accountBindings?.topic?.[topicKey]
      ?? (canFallbackToLegacy ? telegram.topic?.[topicKey] : null)
      ?? null;
  }
  return null;
}

function resolveFeishuBinding(bindings, conversationRef) {
  const feishu = bindings.feishu ?? {};
  const accountBindings = feishu.accounts?.[conversationRef.accountId ?? 'default'] ?? null;
  const scoped = accountBindings ?? feishu;
  if (conversationRef.scope === 'dm') return scoped.dm?.[conversationRef.participantId] ?? null;
  if (conversationRef.scope === 'group') return scoped.group?.[conversationRef.conversationId] ?? null;
  return null;
}

function resolveWechatBinding(bindings, conversationRef) {
  const wechat = bindings.wechat ?? {};
  const accountBindings = wechat.accounts?.[conversationRef.accountId ?? 'default'] ?? null;
  if (conversationRef.scope === 'dm') {
    return accountBindings?.dm?.[conversationRef.participantId]
      ?? (Object.keys(wechat.accounts ?? {}).length <= 1 ? wechat.dm?.[conversationRef.participantId] : null)
      ?? null;
  }
  return null;
}

export class ConversationRouter {
  constructor({ bindings, agentRegistry }) {
    this.bindings = bindings;
    this.agentRegistry = agentRegistry;
  }

  route(inboundMessage) {
    const conversationKey = buildConversationKey(inboundMessage.conversationRef);
    const binding = inboundMessage.channel === 'telegram'
      ? resolveTelegramBinding(this.bindings, inboundMessage.conversationRef)
      : inboundMessage.channel === 'feishu'
        ? resolveFeishuBinding(this.bindings, inboundMessage.conversationRef)
        : inboundMessage.channel === 'wechat'
          ? resolveWechatBinding(this.bindings, inboundMessage.conversationRef)
        : null;
    if (!binding?.instanceId) {
      throw new CrewlineError({
        code: ErrorCodes.ROUTE_BINDING_NOT_FOUND,
        layer: 'core',
        recoverable: false,
        message: `No binding found for conversation ${conversationKey}`
      });
    }
    const instance = this.agentRegistry.getInstance(binding.instanceId);
    return createRouteDecision({
      conversationKey,
      conversationRef: inboundMessage.conversationRef,
      instanceId: instance.instanceId,
      providerId: instance.providerId,
      agentName: instance.agent,
      resolvedCwd: instance.cwd,
      approvalMode: instance.approvalMode
    });
  }
}
