export function createRuntimeResult(input) {
  return Object.freeze({
    ok: input.ok,
    sessionId: input.sessionId,
    outputText: input.outputText,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    terminal: input.terminal ?? false,
    latencyMs: input.latencyMs,
    runtimeHandle: input.runtimeHandle
  });
}
