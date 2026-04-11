import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from '../../shared/utils/jsonl.js';

async function walkFiles(root, predicate, found = []) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await walkFiles(fullPath, predicate, found);
      } else if (predicate(fullPath)) {
        found.push(fullPath);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return found;
}

function inferConversationLogPath({ dataDir, bindingFile }) {
  const relative = path.relative(path.join(dataDir, 'bindings'), bindingFile);
  const segments = relative.split(path.sep);
  if (segments.length < 3) return null;
  const [channel, scope, fileName] = segments;
  return path.join(dataDir, 'conversations', channel, scope, fileName.replace(/\.json$/, '.jsonl'));
}

async function compactBindingFile(filePath, dataDir) {
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const next = { ...raw };
  let changed = false;

  if (!next.bindingState && next.state) {
    next.bindingState = next.state;
    changed = true;
  }
  if (!next.state && next.bindingState) {
    next.state = next.bindingState;
    changed = true;
  }
  if (next.turnLogPath) {
    delete next.turnLogPath;
    changed = true;
  }
  if (!next.conversationLogPath) {
    const inferred = inferConversationLogPath({ dataDir, bindingFile: filePath });
    if (inferred) {
      next.conversationLogPath = inferred;
      changed = true;
    }
  }

  if (changed) {
    await writeJson(filePath, next);
  }
  return changed;
}

async function compactConversationLog(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const normalized = [];
  let droppedLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      normalized.push(JSON.stringify(JSON.parse(line)));
    } catch {
      droppedLines += 1;
    }
  }
  const next = normalized.length ? `${normalized.join('\n')}\n` : '';
  const changed = next !== content;
  if (changed) {
    await fs.writeFile(filePath, next, 'utf8');
  }
  return { changed, droppedLines };
}

export async function compactState({ dataDir } = {}) {
  if (!dataDir) {
    return { ok: false, compacted: false, reason: 'missing-data-dir' };
  }

  const bindingFiles = await walkFiles(
    path.join(dataDir, 'bindings'),
    (filePath) => filePath.endsWith('.json')
  );
  const conversationLogs = await walkFiles(
    path.join(dataDir, 'conversations'),
    (filePath) => filePath.endsWith('.jsonl')
  );

  let compactedBindings = 0;
  for (const filePath of bindingFiles) {
    if (await compactBindingFile(filePath, dataDir)) {
      compactedBindings += 1;
    }
  }

  let compactedLogs = 0;
  let droppedLogLines = 0;
  for (const filePath of conversationLogs) {
    const result = await compactConversationLog(filePath);
    if (result.changed) compactedLogs += 1;
    droppedLogLines += result.droppedLines;
  }

  return {
    ok: true,
    compacted: compactedBindings > 0 || compactedLogs > 0 || droppedLogLines > 0,
    compactedBindings,
    compactedLogs,
    droppedLogLines
  };
}
