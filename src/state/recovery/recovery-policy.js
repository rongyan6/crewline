import { ErrorCodes } from '../../shared/errors/error-codes.js';

export function shouldRecreateSession(runtimeResult) {
  if (!runtimeResult || runtimeResult.ok) return false;
  return [
    ErrorCodes.RUNTIME_SESSION_LOST
  ].includes(runtimeResult.errorCode);
}
