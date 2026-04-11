import fs from 'node:fs/promises';
import path from 'node:path';

const CURRENT_LOG_NAME = 'crewline.log';
const DATED_LOG_PREFIX = 'crewline-';
const DATED_LOG_SUFFIX = '.log';

function pad(value) {
  return String(value).padStart(2, '0');
}

export function formatLogStamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
}

export function buildDatedLogFilePath(logDir, date = new Date()) {
  return path.join(logDir, `${DATED_LOG_PREFIX}${formatLogStamp(date)}${DATED_LOG_SUFFIX}`);
}

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureUniquePath(targetPath) {
  if (!(await pathExists(targetPath))) return targetPath;
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = targetPath.replace(/\.log$/, `-${index}.log`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Unable to allocate unique log file path for ${targetPath}`);
}

function isManagedLogFile(name) {
  return /^crewline-\d{8}-\d{6}(?:-\d+)?\.log$/.test(name) || /^crewline\.log\.bak\./.test(name);
}

async function migrateLegacyCurrentLog(logDir) {
  const currentPath = path.join(logDir, CURRENT_LOG_NAME);
  let stat;
  try {
    stat = await fs.lstat(currentPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  if (stat.isSymbolicLink()) return null;

  const backupPath = await ensureUniquePath(buildDatedLogFilePath(logDir, stat.mtime));
  await fs.rename(currentPath, backupPath);
  return backupPath;
}

export async function pruneOldLogFiles({ logDir, now = new Date(), retentionDays = 7 } = {}) {
  const cutoffMs = now.getTime() - (retentionDays * 24 * 60 * 60 * 1000);
  let entries = [];
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isManagedLogFile(entry.name)) continue;
    const fullPath = path.join(logDir, entry.name);
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs >= cutoffMs) continue;
    await fs.rm(fullPath, { force: true });
    removed.push(fullPath);
  }
  return removed;
}

export async function prepareStartupLogFile({ logDir, now = new Date(), retentionDays = 7 } = {}) {
  await fs.mkdir(logDir, { recursive: true });
  const migratedLegacyLog = await migrateLegacyCurrentLog(logDir);
  const logFile = await ensureUniquePath(buildDatedLogFilePath(logDir, now));
  await fs.writeFile(logFile, '', { flag: 'a' });

  const currentPath = path.join(logDir, CURRENT_LOG_NAME);
  await fs.rm(currentPath, { force: true });
  try {
    await fs.symlink(path.basename(logFile), currentPath);
  } catch {
    // Windows commonly blocks file symlink creation for non-elevated users.
    // Fall back to a hard link so crewline.log still tracks the active file.
    await fs.link(logFile, currentPath);
  }

  const prunedFiles = await pruneOldLogFiles({ logDir, now, retentionDays });
  return {
    logFile,
    currentPath,
    migratedLegacyLog,
    prunedFiles
  };
}
