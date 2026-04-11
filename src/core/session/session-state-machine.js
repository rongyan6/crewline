import { SessionStates } from './session-types.js';
import { CrewlineError } from '../../shared/errors/error-envelope.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';

const transitions = new Map([
  [SessionStates.MISSING, new Set([SessionStates.CREATING])],
  [SessionStates.CREATING, new Set([SessionStates.ACTIVE, SessionStates.FAILED])],
  [SessionStates.ACTIVE, new Set([SessionStates.ACTIVE, SessionStates.RECOVERING])],
  [SessionStates.RECOVERING, new Set([SessionStates.ACTIVE, SessionStates.RECREATING, SessionStates.FAILED])],
  [SessionStates.RECREATING, new Set([SessionStates.ACTIVE, SessionStates.FAILED])],
  [SessionStates.FAILED, new Set([SessionStates.CREATING, SessionStates.RECOVERING])]
]);

export function assertTransition(from, to) {
  const allowed = transitions.get(from);
  if (!allowed?.has(to)) {
    throw new CrewlineError({
      code: ErrorCodes.SESSION_STATE_CONFLICT,
      layer: 'core',
      recoverable: false,
      message: `Invalid session transition: ${from} -> ${to}`
    });
  }
}

export function transitionSession(currentState, nextState) {
  assertTransition(currentState, nextState);
  return nextState;
}
