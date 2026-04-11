import fs from 'node:fs/promises';

export async function loadJsonConfig(configPath, { optional = false } = {}) {
  try {
    const content = await fs.readFile(configPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadConfig(configPath) {
  return loadJsonConfig(configPath);
}
