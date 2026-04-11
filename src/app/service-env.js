import { resolveRuntimePaths } from './runtime-paths.js';

function pickEnv(inputEnv, keys) {
  const output = {};
  for (const key of keys) {
    const value = inputEnv[key];
    if (typeof value === 'string' && value.trim()) {
      output[key] = value.trim();
    }
  }
  return output;
}

export function buildServiceEnvironment(env = process.env) {
  const { runtimeHome, configPath, systemConfigPath, defaultLogDir } = resolveRuntimePaths(env);
  return {
    ...pickEnv(env, [
      'PATH',
      'HOME',
      'TMPDIR',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'all_proxy',
      'NODE_EXTRA_CA_CERTS',
      'NODE_USE_SYSTEM_CA',
      'CREWLINE_ACPX_BIN'
    ]),
    CREWLINE_SERVICE_MODE: env.CREWLINE_SERVICE_MODE?.trim() || 'launchd',
    CREWLINE_RUNTIME_HOME: runtimeHome,
    CREWLINE_CONFIG_PATH: configPath,
    CREWLINE_SYSTEM_CONFIG_PATH: systemConfigPath,
    CREWLINE_LOG_DIR: env.CREWLINE_LOG_DIR?.trim() || defaultLogDir
  };
}
