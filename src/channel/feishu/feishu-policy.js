function buildMentionInfoMap(mentions = [], botOpenId) {
  return {
    mentionAll: mentions.some((mention) => mention?.key === '@_all'),
    botMentioned: mentions.some((mention) => mention?.id?.open_id && mention.id.open_id === botOpenId),
    mentionsByKey: new Map(
      mentions
        .filter((mention) => mention?.key)
        .map((mention) => [mention.key, mention])
    )
  };
}

export function normalizeFeishuMentions(message, botOpenId) {
  return buildMentionInfoMap(message?.mentions ?? [], botOpenId);
}

function normalizeStringList(values = []) {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

function resolveGroupOverride(accountConfig = {}, conversationId) {
  const wildcard = accountConfig.groups?.['*'] ?? null;
  const exact = accountConfig.groups?.[conversationId] ?? null;
  return {
    wildcard,
    exact,
    merged: {
      ...(wildcard ?? {}),
      ...(exact ?? {})
    }
  };
}

function resolveOfficialGroupPolicy(accountConfig, conversationId) {
  const { wildcard, exact, merged } = resolveGroupOverride(accountConfig, conversationId);
  const explicitOfficial =
    merged.requireMention !== undefined ||
    merged.groupAllowFrom !== undefined ||
    merged.allowFrom !== undefined ||
    accountConfig.requireMention !== undefined ||
    accountConfig.groupAllowFrom !== undefined;

  if (!explicitOfficial) return null;

  if (merged.enabled === false) {
    return {
      enabled: false,
      requireMention: true,
      groupAllowFrom: [],
      allowAll: false
    };
  }

  const requireMention = merged.requireMention
    ?? accountConfig.requireMention
    ?? true;

  const scopedAllowFrom = exact?.groupAllowFrom !== undefined
    ? exact.groupAllowFrom
    : exact?.allowFrom !== undefined
      ? exact.allowFrom
      : wildcard?.groupAllowFrom !== undefined
        ? wildcard.groupAllowFrom
        : wildcard?.allowFrom !== undefined
          ? wildcard.allowFrom
          : accountConfig.groupAllowFrom;

  const normalizedAllowFrom = normalizeStringList(scopedAllowFrom);

  return {
    enabled: true,
    requireMention,
    groupAllowFrom: normalizedAllowFrom,
    allowAll: false
  };
}

function resolveDefaultGroupPolicy(accountConfig, conversationId) {
  const { merged } = resolveGroupOverride(accountConfig, conversationId);
  const requireMention = merged.requireMention !== false;
  return {
    enabled: merged.enabled !== false,
    requireMention,
    groupAllowFrom: normalizeStringList(accountConfig.groupAllowFrom),
    allowAll: false
  };
}

function resolveEffectiveGroupPolicy(accountConfig, conversationId) {
  return resolveOfficialGroupPolicy(accountConfig, conversationId)
    ?? resolveDefaultGroupPolicy(accountConfig, conversationId);
}

function normalizeCommandCandidate(text = '') {
  return String(text ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .split(/\s+/, 1)[0]
    ?.toLowerCase() ?? '';
}

function parseRawFeishuTextContent(content) {
  if (typeof content !== 'string' || !content.trim()) return '';
  try {
    const parsed = JSON.parse(content);
    return typeof parsed?.text === 'string' ? parsed.text : '';
  } catch {
    return content;
  }
}

function isBootstrapAdminCommand({ text = '', message } = {}) {
  if (normalizeCommandCandidate(text) === '/admin_reg') {
    return true;
  }
  const rawText = parseRawFeishuTextContent(message?.content);
  if (normalizeCommandCandidate(rawText) === '/admin_reg') {
    return true;
  }
  return String(message?.content ?? '').toLowerCase().includes('/admin_reg');
}

export function shouldHandleFeishuInbound({
  message,
  senderOpenId,
  accountState,
  text = ''
}) {
  if (!message?.chat_type || message.chat_type === 'p2p') {
    return { allowed: true };
  }

  if (isBootstrapAdminCommand({ text, message })) {
    return { allowed: true, reason: 'admin_reg_bootstrap' };
  }

  const accountConfig = accountState.config ?? {};
  const { mentionAll, botMentioned } = normalizeFeishuMentions(message, accountState.botOpenId);
  const conversationId = String(message.chat_id);
  const policy = resolveEffectiveGroupPolicy(accountConfig, conversationId);

  if (!policy.enabled) {
    return { allowed: false, reason: 'group_disabled' };
  }

  if (policy.requireMention && !botMentioned) {
    if (mentionAll && accountConfig.respondToMentionAll === true) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'mention_required' };
  }

  const allowFrom = new Set((policy.groupAllowFrom ?? []).map((value) => String(value)));
  return {
    allowed: allowFrom.has(String(senderOpenId)),
    reason: 'sender_not_allowed'
  };
}
