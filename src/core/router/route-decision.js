export function createRouteDecision(input) {
  return Object.freeze({
    conversationKey: input.conversationKey,
    conversationRef: input.conversationRef,
    instanceId: input.instanceId,
    providerId: input.providerId,
    agentName: input.agentName,
    resolvedCwd: input.resolvedCwd,
    approvalMode: input.approvalMode ?? 'default'
  });
}
