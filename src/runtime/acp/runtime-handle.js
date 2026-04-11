export function createRuntimeHandle(input) {
  return Object.freeze({
    backend: 'acpx',
    runtimeSessionName: input.runtimeSessionName,
    sessionKey: input.sessionKey,
    opaqueState: input.opaqueState ?? {}
  });
}
