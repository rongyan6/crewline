import os from 'node:os';
import path from 'node:path';

export function resolveRuntimeHome(env = process.env) {
  const explicit = env.CREWLINE_RUNTIME_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.crewline');
}

export function resolveRuntimePaths(env = process.env) {
  const runtimeHome = resolveRuntimeHome(env);
  return {
    runtimeHome,
    configPath: env.CREWLINE_CONFIG_PATH?.trim() || path.join(runtimeHome, 'crewline.json'),
    systemConfigPath: env.CREWLINE_SYSTEM_CONFIG_PATH?.trim() || path.join(runtimeHome, 'system.json'),
    serviceStatePath: path.join(runtimeHome, 'service-state.json'),
    pidFilePath: path.join(runtimeHome, 'crewline.pid'),
    defaultLogDir: path.join(runtimeHome, 'logs')
  };
}
