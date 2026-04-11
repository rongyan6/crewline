import { createRuntimeResult } from './runtime-result.js';
import { normalizeRuntimeError } from './acpx-errors.js';

export class AcpRuntimeGateway {
  constructor({ client }) {
    this.client = client;
  }

  async ensureSession({ agentId, cwd, sessionName }) {
    return this.client.ensureSession({ agentId, cwd, sessionName });
  }

  async resumeSession({ agentId, cwd, runtimeHandle }) {
    return this.client.resumeSession({ agentId, cwd, runtimeHandle });
  }

  async cancel({ agentId, cwd, runtimeHandle }) {
    return this.client.cancel({ agentId, cwd, runtimeHandle });
  }

  async runTurn(request) {
    const startedAt = Date.now();
    try {
      const result = await this.client.runTurn(request);
      return createRuntimeResult({
        ok: true,
        sessionId: request.sessionId,
        outputText: result.text,
        runtimeHandle: result.runtimeHandle,
        latencyMs: Date.now() - startedAt,
        terminal: false
      });
    } catch (error) {
      const normalized = normalizeRuntimeError(error);
      return createRuntimeResult({
        ok: false,
        sessionId: request.sessionId,
        errorCode: normalized.code,
        errorMessage: normalized.message,
        latencyMs: Date.now() - startedAt,
        terminal: false,
        runtimeHandle: request.runtimeHandle
      });
    }
  }

  async status(params = {}) {
    if (params.agentId && params.runtimeHandle) {
      return this.client.status(params);
    }
    if (typeof this.client.status === 'function') {
      try {
        const result = await this.client.status(params);
        if (result && typeof result === 'object' && Object.keys(params).length === 0) {
          return {
            backend: 'acpx',
            ...result
          };
        }
      } catch {
        // Fall through to a shallow runtime-ready response.
      }
    }
    return { ok: true, backend: 'acpx', available: true };
  }

  async close(handle) {
    return this.client.close(handle);
  }
}
