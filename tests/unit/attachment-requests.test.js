import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAttachmentRequest } from '../../src/channel/host/attachment-requests.js';

test('resolveAttachmentRequest returns direct mode for exact local file send requests', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-attachment-request-direct-'));
  const filePath = path.join(dir, 'README.md');
  await fs.writeFile(filePath, '# hi', 'utf8');

  const result = await resolveAttachmentRequest(`把文件${filePath}发给我`);

  assert.equal(result.mode, 'direct');
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].localPath, filePath);
  assert.equal(result.attachments[0].disposition, 'file');
});

test('resolveAttachmentRequest trims trailing send phrases from attached absolute paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-attachment-request-direct-tight-'));
  const filePath = path.join(dir, 'README.md');
  await fs.writeFile(filePath, '# hi', 'utf8');

  const result = await resolveAttachmentRequest(`把文件${filePath}发给我`);

  assert.equal(result.mode, 'direct');
  assert.equal(result.attachments[0].localPath, filePath);
});

test('resolveAttachmentRequest returns agent mode for fuzzy send requests', async () => {
  const result = await resolveAttachmentRequest('把 markitdown 的 README 发给我');

  assert.equal(result.mode, 'agent');
  assert.match(result.runtimeMessageText, /crewline-send-attachments/);
  assert.match(result.runtimeMessageText, /不要粘贴文件内容/);
});

test('resolveAttachmentRequest leaves content-reading requests to the agent normally', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-attachment-request-read-'));
  const filePath = path.join(dir, 'README.md');
  await fs.writeFile(filePath, '# hi', 'utf8');

  const result = await resolveAttachmentRequest(`总结一下 ${filePath} 的内容`);

  assert.equal(result.mode, 'none');
  assert.equal(result.attachments.length, 0);
  assert.equal(result.runtimeMessageText, `总结一下 ${filePath} 的内容`);
});
