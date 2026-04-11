import { writeServiceState } from './service-state.js';

let shuttingDown = false;

export async function shutdown(app, { signal = 'shutdown', timeoutMs = 10_000 } = {}) {
  if (shuttingDown) return false;
  shuttingDown = true;
  await writeServiceState({
    status: 'stopping',
    signal,
    pid: process.pid,
    updatedAt: new Date().toISOString()
  });
  await app.channelHost.stopAll();
  await app.waitForIdle?.(timeoutMs);
  await app.metrics?.persistSnapshot?.();
  await writeServiceState({
    status: 'stopped',
    signal,
    pid: process.pid,
    updatedAt: new Date().toISOString()
  });
  return true;
}
