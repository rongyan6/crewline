import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpRuntimeGateway } from '../../src/runtime/acp/runtime-gateway.js';

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
