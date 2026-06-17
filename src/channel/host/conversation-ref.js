export function buildConversationKey(conversationRef) {
  const keyParts = [
    conversationRef.channel,
    conversationRef.accountId && conversationRef.accountId !== 'default' ? conversationRef.accountId : null,
    conversationRef.scope,
    conversationRef.conversationId
  ];
  if (conversationRef.scope === 'topic') {
    keyParts.push(conversationRef.topicId ?? conversationRef.participantId ?? 'unknown');
  }
  return keyParts.filter(Boolean).join(':');
}

export function runtimeBindingPath({ dataDir, conversationRef }) {
  const accountSegment = conversationRef.accountId && conversationRef.accountId !== 'default'
    ? `/${conversationRef.accountId}`
    : '';
  const base = `${dataDir}/bindings/${conversationRef.channel}${accountSegment}`;
  if (conversationRef.scope === 'dm') {
    return `${base}/dm/${conversationRef.conversationId}.json`;
  }
  if (conversationRef.scope === 'group') {
    return `${base}/group/${conversationRef.conversationId}.json`;
  }
  if (conversationRef.scope === 'topic') {
    const topicId = conversationRef.topicId ?? conversationRef.participantId ?? 'unknown';
    return `${base}/topic/${conversationRef.conversationId}-${topicId}.json`;
  }
  return `${base}/${conversationRef.scope}/${conversationRef.conversationId}.json`;
}

export function conversationLogPath({ dataDir, conversationRef }) {
  const accountSegment = conversationRef.accountId && conversationRef.accountId !== 'default'
    ? `/${conversationRef.accountId}`
    : '';
  const base = `${dataDir}/conversations/${conversationRef.channel}${accountSegment}/${conversationRef.scope}`;
  if (conversationRef.scope === 'topic') {
    const topicId = conversationRef.topicId ?? conversationRef.participantId ?? 'unknown';
    return `${base}/${conversationRef.conversationId}-${topicId}.jsonl`;
  }
  return `${base}/${conversationRef.conversationId}.jsonl`;
}
