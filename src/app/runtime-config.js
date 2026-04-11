import fs from 'node:fs/promises';
import { loadJsonConfig } from '../config/load-config.js';
import { resolveConfig } from '../config/resolve-config.js';
import { resolveRuntimePaths } from './runtime-paths.js';

async function loadOptionalJson(pathname) {
  return await loadJsonConfig(pathname, { optional: true });
}

export async function loadResolvedRuntimeConfig() {
  const { runtimeHome, configPath, systemConfigPath } = resolveRuntimePaths();
  const userConfig = (await loadOptionalJson(configPath)) ?? {};
  const systemConfig = await loadOptionalJson(systemConfigPath);
  return {
    runtimeHome,
    configPath,
    systemConfigPath,
    userConfig,
    systemConfig,
    config: resolveConfig(userConfig, systemConfig, {}, { configDir: runtimeHome })
  };
}

export async function persistUserConfig(configPath, userConfig) {
  await fs.writeFile(configPath, `${JSON.stringify(userConfig, null, 2)}\n`, 'utf8');
  return userConfig;
}
