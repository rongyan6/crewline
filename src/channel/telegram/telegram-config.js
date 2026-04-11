function normalizeTelegramUserIdList(values = []) {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

export function resolveTelegramConfig(config) {
  return {
    mode: config?.polling?.enabled ? 'polling' : 'webhook',
    timeoutSeconds: config?.polling?.timeoutSeconds ?? 30,
    streaming: config?.streaming === true,
    groupAllowFrom: normalizeTelegramUserIdList(config?.groupAllowFrom ?? config?.allowedUserIds ?? []),
    requireMention: {
      group: config?.requireMention?.group === true,
      topic: config?.requireMention?.topic === true
    },
    groups: Object.fromEntries(
      Object.entries(config?.groups ?? {}).map(([groupId, groupConfig]) => [groupId, {
        ...groupConfig,
        groupAllowFrom: normalizeTelegramUserIdList(groupConfig?.groupAllowFrom)
      }])
    ),
    topics: Object.fromEntries(
      Object.entries(config?.topics ?? {}).map(([topicKey, topicConfig]) => [topicKey, {
        ...topicConfig,
        groupAllowFrom: normalizeTelegramUserIdList(topicConfig?.groupAllowFrom)
      }])
    ),
    network: {
      proxy: config?.network?.proxy ?? null,
      autoSelectFamily: config?.network?.autoSelectFamily ?? true,
      dangerouslyAllowPrivateNetwork:
        config?.network?.dangerouslyAllowPrivateNetwork ?? false
    }
  };
}
