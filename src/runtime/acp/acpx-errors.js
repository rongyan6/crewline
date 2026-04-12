import { CrewlineError } from '../../shared/errors/error-envelope.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';

export function normalizeRuntimeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const isTimeout = error?.code === 'ETIMEDOUT' || /timed out/i.test(message);
  const recoverable = !isTimeout && /session|unavailable/i.test(message);
  return new CrewlineError({
    code: recoverable ? ErrorCodes.RUNTIME_SESSION_LOST : ErrorCodes.RUNTIME_TURN_FAILED,
    layer: 'runtime',
    recoverable,
    message
  });
}
