export function pickDefaultInstanceId(userConfig = {}) {
  const instanceIds = Object.keys(userConfig?.agents?.instances ?? {});
  if (instanceIds.includes('codex_cc')) return 'codex_cc';
  return instanceIds[0] ?? null;
}

export function resolveRequestedInstanceId(userConfig = {}, requestedInstanceId = null) {
  const instanceIds = Object.keys(userConfig?.agents?.instances ?? {});
  if (requestedInstanceId) {
    return instanceIds.includes(requestedInstanceId) ? requestedInstanceId : null;
  }
  return pickDefaultInstanceId(userConfig);
}

export function listAgentInstances(userConfig = {}) {
  return Object.entries(userConfig?.agents?.instances ?? {}).map(([id, instance]) => ({
    id,
    providerId: instance?.providerId ?? null,
    cwd: instance?.cwd ?? null,
    model: instance?.model ?? userConfig?.agents?.providers?.[instance?.providerId]?.model ?? null
  }));
}

export function applyAgentAdd(userConfig = {}, { id, providerId, cwd }) {
  const next = structuredClone(userConfig);
  next.agents ??= {};
  next.agents.instances ??= {};
  next.agents.providers ??= {};
  const existing = next.agents.instances[id] ?? null;
  next.agents.instances[id] = {
    ...(existing ?? {}),
    providerId,
    cwd
  };
  return next;
}

export function applyAgentCwd(userConfig = {}, { id, cwd }) {
  const next = structuredClone(userConfig);
  next.agents ??= {};
  next.agents.instances ??= {};
  next.agents.instances[id] = {
    ...(next.agents.instances[id] ?? {}),
    cwd
  };
  return next;
}

function normalizeStringList(values = []) {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

function ensureAdminUserIds(channelConfig = {}, senderId = '') {
  channelConfig.adminUserIds = normalizeStringList([
    ...(channelConfig.adminUserIds ?? []),
    senderId
  ]);
}

function ensureChannelGroupAllowFrom(channelConfig = {}, senderId = '') {
  channelConfig.groupAllowFrom = normalizeStringList([
    ...(channelConfig.groupAllowFrom ?? []),
    ...(channelConfig.adminUserIds ?? []),
    senderId
  ]);
}

function ensureChannelAdminAccess(channelConfig = {}, senderId = '') {
  ensureAdminUserIds(channelConfig, senderId);
  ensureChannelGroupAllowFrom(channelConfig, senderId);
}

function normalizeObjectAccounts(accounts) {
  if (Array.isArray(accounts)) {
    return Object.fromEntries(
      accounts
        .filter((entry) => typeof entry === 'object' && entry)
        .map((entry, index) => {
          const explicitId = entry.accountId ?? entry.botId ?? entry.id ?? entry.name ?? entry.appId ?? null;
          const accountId = typeof explicitId === 'string' && explicitId.trim()
            ? explicitId.trim()
            : `account_${index + 1}`;
          return [accountId, { ...(entry ?? {}), accountId: undefined, botId: undefined, id: undefined, name: undefined }];
        })
    );
  }
  if (accounts && typeof accounts === 'object') {
    return { ...accounts };
  }
  return {};
}

function ensureTelegramAccountRoot(channelTelegram = {}) {
  if (channelTelegram.accounts && typeof channelTelegram.accounts === 'object' && !Array.isArray(channelTelegram.accounts)) {
    return channelTelegram.accounts;
  }
  const accounts = normalizeObjectAccounts(channelTelegram.accounts);
  channelTelegram.accounts = accounts;
  return accounts;
}

function ensureFeishuAccountRoot(channelFeishu = {}) {
  if (channelFeishu.accounts && typeof channelFeishu.accounts === 'object' && !Array.isArray(channelFeishu.accounts)) {
    return channelFeishu.accounts;
  }
  const accounts = normalizeObjectAccounts(channelFeishu.accounts);
  channelFeishu.accounts = accounts;
  return accounts;
}

export function applyAdminUser(userConfig = {}, { channelId, userId }) {
  const next = structuredClone(userConfig);
  next.channel ??= {};
  const normalizedUserId = String(userId ?? '').trim();
  if (!normalizedUserId) return next;

  if (channelId === 'telegram') {
    next.channel.telegram ??= {};
    ensureChannelAdminAccess(next.channel.telegram, normalizedUserId);
    return next;
  }

  if (channelId === 'feishu') {
    next.channel.feishu ??= {};
    ensureChannelAdminAccess(next.channel.feishu, normalizedUserId);
    return next;
  }

  if (channelId === 'wechat') {
    next.channel.wechat ??= {};
    ensureAdminUserIds(next.channel.wechat, normalizedUserId);
    return next;
  }

  return next;
}

export function getPreferredAgentIdForRegistration(config = {}, inboundMessage) {
  const senderId = String(inboundMessage?.senderRef?.userId ?? '');
  if (!senderId) return pickDefaultInstanceId(config);

  if (inboundMessage?.channel === 'telegram') {
    const accountId = inboundMessage.accountId ?? 'default';
    const telegram = config?.channel?.telegram ?? {};
    const accountBindings = telegram.accounts?.[accountId]?.bindings?.dm ?? {};
    const topLevelBindings = telegram.bindings?.dm ?? {};
    return accountBindings[senderId]?.instanceId
      ?? topLevelBindings[senderId]?.instanceId
      ?? pickDefaultInstanceId(config);
  }

  if (inboundMessage?.channel === 'feishu') {
    const accountId = inboundMessage.accountId ?? 'default';
    const feishu = config?.channel?.feishu ?? {};
    const accountBindings = feishu.accounts?.[accountId]?.bindings?.dm ?? {};
    return accountBindings[senderId]?.instanceId ?? pickDefaultInstanceId(config);
  }

  return pickDefaultInstanceId(config);
}

export function getExistingRegistration(config = {}, inboundMessage) {
  const ref = inboundMessage?.conversationRef ?? {};
  if (inboundMessage?.channel === 'telegram') {
    const accountId = inboundMessage.accountId ?? 'default';
    const telegram = config?.channel?.telegram ?? {};
    const accountBindings = telegram.accounts?.[accountId]?.bindings ?? {};
    if (ref.scope === 'dm') {
      const dmKey = ref.participantId ?? ref.conversationId;
      return accountBindings.dm?.[dmKey] ?? telegram.bindings?.dm?.[dmKey] ?? null;
    }
    if (ref.scope === 'group') {
      return accountBindings.group?.[ref.conversationId] ?? telegram.bindings?.group?.[ref.conversationId] ?? null;
    }
    if (ref.scope === 'topic') {
      const topicKey = `${ref.conversationId}:${ref.topicId}`;
      return accountBindings.topic?.[topicKey] ?? telegram.bindings?.topic?.[topicKey] ?? null;
    }
    return null;
  }

  if (inboundMessage?.channel === 'feishu') {
    const accountId = inboundMessage.accountId ?? 'default';
    const feishu = config?.channel?.feishu ?? {};
    const accountBindings = feishu.accounts?.[accountId]?.bindings ?? {};
    if (ref.scope === 'dm') {
      const dmKey = ref.participantId ?? ref.conversationId;
      return accountBindings.dm?.[dmKey] ?? null;
    }
    if (ref.scope === 'group') {
      return accountBindings.group?.[ref.conversationId] ?? null;
    }
  }

  return null;
}

export function applyConversationRegistration(userConfig = {}, inboundMessage, instanceId) {
  const next = structuredClone(userConfig);
  next.channel ??= {};

  if (inboundMessage?.channel === 'telegram') {
    next.channel.telegram ??= {};
    const telegram = next.channel.telegram;
    const accountId = inboundMessage.accountId ?? 'default';
    const senderId = String(inboundMessage?.senderRef?.userId ?? '');
    const ref = inboundMessage.conversationRef ?? {};
    const dmKey = String(ref.participantId ?? ref.conversationId ?? senderId);

    ensureChannelAdminAccess(telegram, senderId);

    if (accountId && accountId !== 'default') {
      const accounts = ensureTelegramAccountRoot(telegram);
      accounts[accountId] ??= {};
      accounts[accountId].bindings ??= {};
      accounts[accountId].bindings.dm ??= {};
      accounts[accountId].bindings.group ??= {};
      accounts[accountId].bindings.topic ??= {};
      if (ref.scope === 'dm') {
        accounts[accountId].bindings.dm[dmKey] = { instanceId };
      }
      if (ref.scope === 'group') {
        accounts[accountId].bindings.group[ref.conversationId] = { instanceId };
        telegram.groups ??= {};
        telegram.groups[ref.conversationId] ??= {};
        telegram.groups[ref.conversationId].groupAllowFrom = normalizeStringList([
          ...(telegram.groups[ref.conversationId].groupAllowFrom ?? []),
          senderId
        ]);
      }
      if (ref.scope === 'topic') {
        const topicKey = `${ref.conversationId}:${ref.topicId}`;
        accounts[accountId].bindings.topic[topicKey] = { instanceId };
        telegram.topics ??= {};
        telegram.topics[topicKey] ??= {};
        telegram.topics[topicKey].groupAllowFrom = normalizeStringList([
          ...(telegram.topics[topicKey].groupAllowFrom ?? []),
          senderId
        ]);
      }
      return next;
    }

    telegram.bindings ??= {};
    telegram.bindings.dm ??= {};
    telegram.bindings.group ??= {};
    telegram.bindings.topic ??= {};
    if (ref.scope === 'dm') {
      telegram.bindings.dm[dmKey] = { instanceId };
    }
    if (ref.scope === 'group') {
      telegram.bindings.group[ref.conversationId] = { instanceId };
      telegram.groups ??= {};
      telegram.groups[ref.conversationId] ??= {};
      telegram.groups[ref.conversationId].groupAllowFrom = normalizeStringList([
        ...(telegram.groups[ref.conversationId].groupAllowFrom ?? []),
        senderId
      ]);
    }
    if (ref.scope === 'topic') {
      const topicKey = `${ref.conversationId}:${ref.topicId}`;
      telegram.bindings.topic[topicKey] = { instanceId };
      telegram.topics ??= {};
      telegram.topics[topicKey] ??= {};
      telegram.topics[topicKey].groupAllowFrom = normalizeStringList([
        ...(telegram.topics[topicKey].groupAllowFrom ?? []),
        senderId
      ]);
    }
    return next;
  }

  if (inboundMessage?.channel === 'feishu') {
    next.channel.feishu ??= {};
    const feishu = next.channel.feishu;
    const accountId = inboundMessage.accountId ?? 'default';
    const senderId = String(inboundMessage?.senderRef?.userId ?? '');
    const ref = inboundMessage.conversationRef ?? {};
    const dmKey = String(ref.participantId ?? ref.conversationId ?? senderId);
    const accounts = ensureFeishuAccountRoot(feishu);
    ensureChannelAdminAccess(feishu, senderId);
    accounts[accountId] ??= {};
    accounts[accountId].bindings ??= {};
    accounts[accountId].bindings.dm ??= {};
    accounts[accountId].bindings.group ??= {};
    accounts[accountId].groups ??= {};
    if (ref.scope === 'dm') {
      accounts[accountId].bindings.dm[dmKey] = { instanceId };
    }
    if (ref.scope === 'group') {
      accounts[accountId].bindings.group[ref.conversationId] = { instanceId };
      accounts[accountId].groups[ref.conversationId] ??= {};
      accounts[accountId].groups[ref.conversationId].groupAllowFrom = normalizeStringList([
        ...(accounts[accountId].groups[ref.conversationId].groupAllowFrom ?? []),
        senderId
      ]);
    }
    return next;
  }

  return next;
}
