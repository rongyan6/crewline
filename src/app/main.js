import path from 'node:path';
import { loadConfig, loadJsonConfig } from '../config/load-config.js';
import { validateConfig } from '../config/validate-config.js';
import { resolveConfig } from '../config/resolve-config.js';
import { bootstrap } from './bootstrap.js';
import { shutdown } from './shutdown.js';
import { writeServiceState } from './service-state.js';
import { resolveRuntimePaths } from './runtime-paths.js';

async function main() {
  const { runtimeHome, configPath, systemConfigPath } = resolveRuntimePaths();
  const userConfig = await loadConfig(configPath);
  const systemConfig = await loadJsonConfig(systemConfigPath, { optional: true });
  const configDir = path.dirname(configPath);
  validateConfig(userConfig, {});
  const finalConfig = resolveConfig(userConfig, systemConfig, {}, { configDir });
  const app = await bootstrap({ config: finalConfig });
  const serviceMode = process.env.CREWLINE_SERVICE_MODE ?? 'direct';

  const updateHeartbeat = async (status = 'running') => {
    await writeServiceState({
      status,
      pid: process.pid,
      mode: serviceMode,
      runtimeHome,
      updatedAt: new Date().toISOString(),
      metricsPath: path.join(finalConfig.runtime.dataDir, 'metrics', 'snapshot.json')
    });
  };

  await updateHeartbeat('starting');
  await app.channelHost.startAll();
  app.logger.info('Crewline bootstrapped');
  await updateHeartbeat('running');

  const heartbeat = setInterval(() => {
    void updateHeartbeat('running');
  }, 30_000);
  heartbeat.unref();

  const handleSignal = async (signal) => {
    clearInterval(heartbeat);
    try {
      await shutdown(app, {
        signal,
        timeoutMs: finalConfig.runtime?.gracefulShutdownMs ?? 10_000
      });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => {
    void handleSignal('SIGTERM');
  });
  process.on('SIGINT', () => {
    void handleSignal('SIGINT');
  });
}

main().catch((error) => {
  void writeServiceState({
    status: 'failed',
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    error: error?.message ?? String(error)
  }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
