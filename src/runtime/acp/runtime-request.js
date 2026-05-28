export function createRuntimeRequest(input) {
  return Object.freeze({
    agentId: input.agentId,
    sessionId: input.sessionId,
    runtimeHandle: input.runtimeHandle,
    cwd: input.cwd,
    approvalMode: input.approvalMode ?? 'default',
    model: input.model,
    messageText: input.messageText,
    metadata: input.metadata ?? {},
    onChunk: input.onChunk
  });
}
