import fs from 'node:fs';
import path from 'node:path';

function resolveDebugModePath(dataDir) {
  return path.join(dataDir, 'channels', 'wechat', 'debug-mode.json');
}

function loadState(dataDir) {
  try {
    const raw = fs.readFileSync(resolveDebugModePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.accounts === 'object') return parsed;
  } catch {}
  return { accounts: {} };
}

function saveState(dataDir, state) {
  const filePath = resolveDebugModePath(dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

export function toggleWechatDebugMode(dataDir, accountId) {
  const state = loadState(dataDir);
  const next = !state.accounts[accountId];
  state.accounts[accountId] = next;
  saveState(dataDir, state);
  return next;
}

export function isWechatDebugMode(dataDir, accountId) {
  return loadState(dataDir).accounts[accountId] === true;
}
