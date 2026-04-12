import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpRuntimeGateway } from '../../src/runtime/acp/runtime-gateway.js';
import { ErrorCodes } from '../../src/shared/errors/error-codes.js';

class FakeClient {
  async ensureSession() {
    return { runtimeSessionName: 's', sessionKey: 'k', backend: 'acpx' };
  }
  async runTurn() {
    return { text: 'hi', runtimeHandle: { runtimeSessionName: 's', sessionKey: 'k', backend: 'acpx' } };
  }
  async close() { return { ok: true }; }
}

test('runtime gateway returns normalized success result', async () => {
  const gateway = new AcpRuntimeGateway({ client: new FakeClient() });
  const result = await gateway.runTurn({ sessionId: 's1', runtimeHandle: { runtimeSessionName: 's', sessionKey: 'k' } });
  assert.equal(result.ok, true);
  assert.equal(result.outputText, 'hi');
});

test('runtime gateway treats command timeout as turn failure instead of session loss', async () => {
  const gateway = new AcpRuntimeGateway({
    client: {
      async runTurn() {
        const error = new Error('acpx command timed out after 600000ms: npx -y acpx@0.5.2 codex');
        error.code = 'ETIMEDOUT';
        throw error;
      }
    }
  });

  const result = await gateway.runTurn({
    sessionId: 's2',
    runtimeHandle: { runtimeSessionName: 's', sessionKey: 'k' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, ErrorCodes.RUNTIME_TURN_FAILED);
  assert.match(result.errorMessage, /600000ms/);
});
