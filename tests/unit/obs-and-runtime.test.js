import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Metrics } from '../../src/obs/metrics.js';
import { AuditTrail } from '../../src/obs/audit.js';
import { healthcheck } from '../../src/obs/healthcheck.js';
import { AcpRuntimeGateway } from '../../src/runtime/acp/runtime-gateway.js';

test('metrics persists counter and timing snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-metrics-'));
  const metrics = new Metrics({
    filePath: path.join(dir, 'events.jsonl'),
    snapshotPath: path.join(dir, 'snapshot.json')
  });

  await metrics.increment('messages.inbound', 1, { channel: 'telegram' });
  await metrics.timing('turn.total_ms', 42, { outcome: 'ok' });

  const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.counters['messages.inbound|channel=telegram'], 1);
  assert.equal(snapshot.timings['turn.total_ms|outcome=ok'].count, 1);
});

test('audit trail appends events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-audit-'));
  const audit = new AuditTrail({
    filePath: path.join(dir, 'audit.jsonl')
  });

  await audit.record({ event: 'message.inbound', channel: 'telegram' });
  const content = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf8');
  const [entry] = content.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entry.event, 'message.inbound');
  assert.equal(entry.channel, 'telegram');
});

test('healthcheck aggregates runtime, channels, metrics and service state', async () => {
  const result = await healthcheck({
    channelHost: {
      plugins: new Map([
        ['telegram', { healthcheck: async () => ({ ok: true, channel: 'telegram' }) }]
      ])
    },
    runtimeGateway: {
      status: async () => ({ ok: true, backend: 'acpx' })
    },
    stateStore: { dataDir: '/tmp/.crewline' },
    metrics: { snapshot: () => ({ counters: { foo: 1 }, timings: {}, updatedAt: 'now' }) },
    serviceState: { status: 'running' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.channels.length, 1);
  assert.equal(result.runtime.backend, 'acpx');
  assert.equal(result.metrics.counters.foo, 1);
});

test('runtime gateway delegates status and cancel to client', async () => {
  const calls = [];
  const gateway = new AcpRuntimeGateway({
    client: {
      async status(params) {
        calls.push(['status', params]);
        return { ok: true, payload: { status: 'idle' } };
      },
      async cancel(params) {
        calls.push(['cancel', params]);
        return { ok: true };
      }
    }
  });

  const status = await gateway.status({ agentId: 'codex', runtimeHandle: { runtimeSessionName: 's' } });
  const cancel = await gateway.cancel({ agentId: 'codex', runtimeHandle: { runtimeSessionName: 's' } });

  assert.equal(status.ok, true);
  assert.equal(cancel.ok, true);
  assert.equal(calls.length, 2);
});
