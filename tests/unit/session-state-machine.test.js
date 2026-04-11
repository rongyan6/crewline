import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionSession } from '../../src/core/session/session-state-machine.js';
import { SessionStates } from '../../src/core/session/session-types.js';

test('allows valid session transition', () => {
  assert.equal(transitionSession(SessionStates.MISSING, SessionStates.CREATING), SessionStates.CREATING);
});

test('rejects invalid session transition', () => {
  assert.throws(() => transitionSession(SessionStates.MISSING, SessionStates.ACTIVE));
});
