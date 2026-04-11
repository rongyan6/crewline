import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function appendJsonl(filePath, value) {
  await ensureParent(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureParent(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
