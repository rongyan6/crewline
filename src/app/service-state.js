import { writeJson, readJson } from '../shared/utils/jsonl.js';
import { resolveRuntimePaths } from './runtime-paths.js';

export function resolveServiceStatePath(env = process.env) {
  return resolveRuntimePaths(env).serviceStatePath;
}

export async function writeServiceState(value) {
  await writeJson(resolveServiceStatePath(), value);
}

export async function readServiceState() {
  return readJson(resolveServiceStatePath(), null);
}
