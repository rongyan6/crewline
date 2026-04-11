import fs from 'node:fs/promises';
import path from 'node:path';

async function countFiles(rootPath) {
  if (!rootPath) return 0;
  let stat;
  try {
    stat = await fs.stat(rootPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  if (!stat.isDirectory()) return 1;
  let count = 0;
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(childPath);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

async function readStateStoreHealth(stateStore) {
  const dataDir = stateStore?.dataDir ?? null;
  if (!dataDir) {
    return {
      ok: false,
      dataDir: null,
      runtimeBindings: 0,
      conversationLogs: 0
    };
  }
  const runtimeBindings = await countFilesInFirstExistingPath([
    path.join(dataDir, 'bindings'),
    path.join(dataDir, 'state', 'bindings')
  ]);
  const conversationLogs = await countFiles(path.join(dataDir, 'conversations'));
  return {
    ok: true,
    dataDir,
    runtimeBindings,
    conversationLogs
  };
}

async function countFilesInFirstExistingPath(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return await countFiles(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return 0;
}

export async function healthcheck({ channelHost, runtimeGateway, stateStore, metrics, serviceState } = {}) {
  const channels = [];
  if (channelHost?.plugins instanceof Map) {
    for (const plugin of channelHost.plugins.values()) {
      try {
        channels.push(await plugin.healthcheck?.() ?? { ok: true, channel: plugin.id });
      } catch (error) {
        channels.push({
          ok: false,
          channel: plugin.id,
          reason: error?.message ?? String(error)
        });
      }
    }
  }

  const runtime = runtimeGateway ? await runtimeGateway.status() : { ok: false, backend: 'acpx', reason: 'missing-runtime' };
  const snapshot = metrics?.snapshot?.() ?? null;
  const storeHealth = await readStateStoreHealth(stateStore);
  const serviceOk = !serviceState || !['failed'].includes(serviceState.status);
  const status = {
    ok: runtime.ok !== false && channels.every((channel) => channel.ok !== false) && serviceOk,
    checkedAt: new Date().toISOString(),
    runtime,
    channels,
    stateStore: storeHealth,
    metrics: snapshot,
    service: serviceState ?? null
  };
  return status;
}
