import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDatedLogFilePath, formatLogStamp, prepareStartupLogFile, pruneOldLogFiles } from '../../src/obs/log-file-manager.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'crewline-logs-'));
}

test('formatLogStamp emits sortable startup timestamp', () => {
  const stamp = formatLogStamp(new Date('2026-04-08T09:10:11+08:00'));
  assert.equal(stamp, '20260408-091011');
});

test('prepareStartupLogFile creates a dated log file and updates crewline.log symlink', async () => {
  const logDir = await makeTempDir();
  const now = new Date('2026-04-08T09:10:11+08:00');

  const result = await prepareStartupLogFile({ logDir, now, retentionDays: 7 });

  assert.equal(path.basename(result.logFile), 'crewline-20260408-091011.log');
  const currentPath = path.join(logDir, 'crewline.log');
  const currentStat = await fs.lstat(currentPath);
  assert.equal(currentStat.isSymbolicLink(), true);
  assert.equal(await fs.readlink(currentPath), 'crewline-20260408-091011.log');
});

test('prepareStartupLogFile falls back to a hard link when symlink creation fails', async () => {
  const logDir = await makeTempDir();
  const now = new Date('2026-04-08T09:10:11+08:00');
  const currentPath = path.join(logDir, 'crewline.log');
  const originalSymlink = fs.symlink;

  try {
    fs.symlink = async () => {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    };

    const result = await prepareStartupLogFile({ logDir, now, retentionDays: 7 });
    const currentStat = await fs.lstat(currentPath);
    const logStat = await fs.lstat(result.logFile);

    assert.equal(currentStat.isSymbolicLink(), false);
    assert.equal(currentStat.ino, logStat.ino);
  } finally {
    fs.symlink = originalSymlink;
  }
});

test('prepareStartupLogFile migrates a legacy current log into a dated backup', async () => {
  const logDir = await makeTempDir();
  const legacyPath = path.join(logDir, 'crewline.log');
  await fs.writeFile(legacyPath, 'legacy log');
  const legacyDate = new Date('2026-04-01T00:00:00+08:00');
  await fs.utimes(legacyPath, legacyDate, legacyDate);

  const result = await prepareStartupLogFile({ logDir, now: new Date('2026-04-08T09:10:11+08:00'), retentionDays: 30 });

  assert.equal(path.basename(result.migratedLegacyLog), 'crewline-20260401-000000.log');
  assert.equal(await fs.readFile(result.migratedLegacyLog, 'utf8'), 'legacy log');
  assert.equal(await fs.readlink(path.join(logDir, 'crewline.log')), 'crewline-20260408-091011.log');
});

test('pruneOldLogFiles removes managed logs older than retention window', async () => {
  const logDir = await makeTempDir();
  const oldLog = buildDatedLogFilePath(logDir, new Date('2026-03-20T00:00:00+08:00'));
  const freshLog = buildDatedLogFilePath(logDir, new Date('2026-04-07T00:00:00+08:00'));
  await fs.writeFile(oldLog, 'old');
  await fs.writeFile(freshLog, 'fresh');
  await fs.utimes(oldLog, new Date('2026-03-20T00:00:00+08:00'), new Date('2026-03-20T00:00:00+08:00'));
  await fs.utimes(freshLog, new Date('2026-04-07T00:00:00+08:00'), new Date('2026-04-07T00:00:00+08:00'));

  const removed = await pruneOldLogFiles({ logDir, now: new Date('2026-04-08T00:00:00+08:00'), retentionDays: 7 });

  assert.deepEqual(removed, [oldLog]);
  await assert.rejects(fs.access(oldLog));
  await fs.access(freshLog);
});
