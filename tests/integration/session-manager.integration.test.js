import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { SessionManager } from '../../src/core/session/session-manager.js';
import { StateStore } from '../../src/state/store/state-store.js';
import { RuntimeBindingStore } from '../../src/state/store/runtime-binding-store.js';
import { ConversationLog } from '../../src/state/store/conversation-log.js';
import { runtimeBindingPath } from '../../src/channel/host/conversation-ref.js';

class FakeRuntimeGateway {
  constructor() {
    this.failFirstTurn = false;
    this.turns = 0;
    this.closed = 0;
  }
  async ensureSession({ agentId }) {
    return { backend: 'acpx', runtimeSessionName: `${agentId}-1`, sessionKey: `${agentId}:1` };
  }
  async runTurn(request) {
    this.turns += 1;
    if (this.failFirstTurn && this.turns === 1) {
      return { ok: false, sessionId: request.sessionId, errorCode: 'RUNTIME_SESSION_LOST', terminal: false };
    }
    return { ok: true, sessionId: request.sessionId, outputText: `echo:${request.messageText}`, runtimeHandle: request.runtimeHandle, terminal: false };
  }
  async close() {
    this.closed += 1;
    return { ok: true };
  }
}

function createStateStore(dir) {
  return new StateStore({
    dataDir: dir,
    runtimeBindingStore: new RuntimeBindingStore((conversationRef) =>
      runtimeBindingPath({ dataDir: dir, conversationRef })
    ),
    conversationLog: new ConversationLog()
  });
}

test('session manager creates and reuses session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-'));
  const manager = new SessionManager({
    stateStore: createStateStore(dir),
    runtimeGateway: new FakeRuntimeGateway()
  });

  const routeDecision = {
    conversationKey: 'telegram:dm:456',
    conversationRef: { channel: 'telegram', conversationId: '456', participantId: '123', scope: 'dm' },
    instanceId: 'codex_cc',
    providerId: 'codex',
    agentName: 'codex',
    resolvedCwd: '/tmp'
  };
  const inbound = {
    text: 'hello'
  };

  const first = await manager.runTurn({ inboundMessage: inbound, routeDecision });
  const second = await manager.runTurn({ inboundMessage: { text: 'again' }, routeDecision });

  assert.equal(first.session.sessionId, second.session.sessionId);
  assert.equal(second.result.outputText, 'echo:again');
});

test('session manager rotates session after maxTurnsPerSession', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-rotate-'));
  const runtimeGateway = new FakeRuntimeGateway();
  const manager = new SessionManager({
    stateStore: createStateStore(dir),
    runtimeGateway,
    sessionPolicy: { maxTurnsPerSession: 1, idleTtlMinutes: 240 }
  });

  const routeDecision = {
    conversationKey: 'telegram:dm:321',
    conversationRef: { channel: 'telegram', conversationId: '321', participantId: '123', scope: 'dm' },
    instanceId: 'codex_cc',
    providerId: 'codex',
    agentName: 'codex',
    resolvedCwd: '/tmp'
  };

  const first = await manager.runTurn({ inboundMessage: { text: 'hello' }, routeDecision });
  const second = await manager.runTurn({ inboundMessage: { text: 'again' }, routeDecision });

  assert.notEqual(first.session.sessionId, second.session.sessionId);
  assert.equal(runtimeGateway.closed, 1);
  assert.equal(second.session.resolvedCwd, '/tmp');
});

test('session manager rotates idle session after ttl expiry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-idle-'));
  const stateStore = createStateStore(dir);
  const runtimeGateway = new FakeRuntimeGateway();
  const manager = new SessionManager({
    stateStore,
    runtimeGateway,
    sessionPolicy: { maxTurnsPerSession: 200, idleTtlMinutes: 1 }
  });

  const routeDecision = {
    conversationKey: 'telegram:dm:654',
    conversationRef: { channel: 'telegram', conversationId: '654', participantId: '123', scope: 'dm' },
    instanceId: 'codex_cc',
    providerId: 'codex',
    agentName: 'codex',
    resolvedCwd: '/tmp'
  };

  await stateStore.runtimeBindingStore.set(routeDecision.conversationRef, {
    sessionId: 'session_old',
    bindingState: 'active',
    runtimeHandle: { backend: 'acpx', runtimeSessionName: 'codex-1', sessionKey: 'codex:1' },
    turnCount: 2,
    updatedAt: '2000-01-01T00:00:00.000Z',
    agentName: 'codex',
    conversationLogPath: path.join(dir, 'conversations', 'telegram', 'dm', '654.jsonl')
  });

  const run = await manager.runTurn({ inboundMessage: { text: 'fresh' }, routeDecision });
  assert.notEqual(run.session.sessionId, 'session_old');
  assert.equal(run.result.outputText, 'echo:fresh');
  assert.equal(runtimeGateway.closed, 1);
  assert.equal(run.session.resolvedCwd, '/tmp');
});

test('session manager recreates session even when retiring old session fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-retire-fail-'));
  const stateStore = createStateStore(dir);
  const runtimeGateway = new FakeRuntimeGateway();
  runtimeGateway.close = async () => {
    throw new Error('No named session');
  };
  const manager = new SessionManager({
    stateStore,
    runtimeGateway,
    sessionPolicy: { maxTurnsPerSession: 1, idleTtlMinutes: 240 }
  });

  const routeDecision = {
    conversationKey: 'telegram:dm:987',
    conversationRef: { channel: 'telegram', conversationId: '987', participantId: '123', scope: 'dm' },
    instanceId: 'codex_cc',
    providerId: 'codex',
    agentName: 'codex',
    resolvedCwd: '/tmp'
  };

  const first = await manager.runTurn({ inboundMessage: { text: 'hello' }, routeDecision });
  const second = await manager.runTurn({ inboundMessage: { text: 'again' }, routeDecision });

  assert.notEqual(first.session.sessionId, second.session.sessionId);
  assert.equal(second.result.outputText, 'echo:again');
});

test('session manager recreates session after runtime session loss', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-recovery-'));
  const runtimeGateway = new FakeRuntimeGateway();
  runtimeGateway.failFirstTurn = true;
  const manager = new SessionManager({
    stateStore: createStateStore(dir),
    runtimeGateway
  });

  const routeDecision = {
    conversationKey: 'telegram:dm:789',
    conversationRef: { channel: 'telegram', conversationId: '789', participantId: '123', scope: 'dm' },
    instanceId: 'codex_cc',
    providerId: 'codex',
    agentName: 'codex',
    resolvedCwd: '/tmp'
  };

  const run = await manager.runTurn({ inboundMessage: { text: 'recover me' }, routeDecision });
  assert.equal(run.result.ok, true);
  assert.equal(run.result.outputText, 'echo:recover me');
  const active = await manager.stateStore.runtimeBindingStore.get(routeDecision.conversationRef);
  assert.equal(active.state, 'active');
});

test('session manager serializes concurrent turns for the same conversation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-serial-'));
  const events = [];
  const runtimeGateway = new FakeRuntimeGateway();
  runtimeGateway.runTurn = async (request) => {
    events.push(`start:${request.messageText}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push(`end:${request.messageText}`);
    return {
      ok: true,
      sessionId: request.sessionId,
      outputText: `echo:${request.messageText}`,
      runtimeHandle: request.runtimeHandle,
      terminal: false
    };
  };
  const manager = new SessionManager({
    stateStore: createStateStore(dir),
    runtimeGateway
  });

  const routeDecision = {
    conversationKey: 'telegram:dm:serial',
    conversationRef: { channel: 'telegram', conversationId: 'serial', participantId: '123', scope: 'dm' },
    instanceId: 'codex_cc',
    providerId: 'codex',
    agentName: 'codex',
    resolvedCwd: '/tmp'
  };

  await Promise.all([
    manager.runTurn({ inboundMessage: { text: 'first' }, routeDecision }),
    manager.runTurn({ inboundMessage: { text: 'second' }, routeDecision })
  ]);

  assert.deepEqual(events, [
    'start:first',
    'end:first',
    'start:second',
    'end:second'
  ]);
});

test('session manager persists runtime binding metadata on active session files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-session-binding-'));
  const manager = new SessionManager({
    stateStore: createStateStore(dir),
    runtimeGateway: new FakeRuntimeGateway()
  });

  const routeDecision = {
    conversationKey: 'telegram:dm:binding',
    conversationRef: { channel: 'telegram', conversationId: 'binding', participantId: '123', scope: 'dm' },
    instanceId: 'codex_cc',
    providerId: 'codex',
    agentName: 'codex',
    resolvedCwd: '/tmp'
  };

  await manager.runTurn({ inboundMessage: { text: 'hello' }, routeDecision });

  const active = await manager.stateStore.runtimeBindingStore.get(routeDecision.conversationRef);
  assert.equal(active.bindingState, 'active');
  assert.equal(active.state, 'active');
  assert.equal(typeof active.createdAt, 'string');
  assert.equal(typeof active.lastUsedAt, 'string');
  assert.equal(active.lastError, null);
  assert.match(active.conversationLogPath, /conversations\/telegram\/dm\/binding\.jsonl$/);
});
