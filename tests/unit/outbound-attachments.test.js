import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAttachmentsFromText } from '../../src/channel/host/outbound-attachments.js';

test('extractAttachmentsFromText strips explicit local_path directives into outbound attachments', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-outbound-attachments-'));
  const reportPath = path.join(dir, 'report.pdf');
  await fs.writeFile(reportPath, 'report-bytes', 'utf8');

  const result = await extractAttachmentsFromText([
    '报告已生成。',
    'file_name: report.pdf',
    `local_path: ${reportPath}`
  ].join('\n'), {
    dataDir: path.join(dir, '.runtime')
  });

  assert.equal(result.text, '报告已生成。');
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].localPath, reportPath);
  assert.equal(result.attachments[0].kind, 'file');
});

test('extractAttachmentsFromText strips standalone markdown image links into outbound attachments', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-outbound-image-'));
  const imagePath = path.join(dir, 'chart image.png');
  await fs.writeFile(imagePath, 'image-bytes', 'utf8');

  const result = await extractAttachmentsFromText([
    '截图如下：',
    `![chart](<${imagePath}>)`
  ].join('\n'), {
    dataDir: path.join(dir, '.runtime')
  });

  assert.equal(result.text, '截图如下：');
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].localPath, imagePath);
  assert.equal(result.attachments[0].kind, 'image');
});

test('extractAttachmentsFromText ignores cached inbound attachment paths under runtime data dir', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-outbound-ignore-'));
  const cachedPath = path.join(dir, 'attachments', 'telegram', '2026-04-19', 'echo.pdf');
  await fs.mkdir(path.dirname(cachedPath), { recursive: true });
  await fs.writeFile(cachedPath, 'echo-bytes', 'utf8');
  const input = [
    '用户发送了一个 Telegram 文件附件。',
    'file_name: echo.pdf',
    `local_path: ${cachedPath}`,
    '请先查看本地文件，再继续处理用户请求。'
  ].join('\n');

  const result = await extractAttachmentsFromText(input, { dataDir: dir });

  assert.equal(result.attachments.length, 0);
  assert.equal(result.text, input);
});

test('extractAttachmentsFromText parses structured crewline attachment action blocks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-outbound-action-'));
  const filePath = path.join(dir, 'README.md');
  await fs.writeFile(filePath, '# hi', 'utf8');

  const result = await extractAttachmentsFromText([
    'README 发你了。',
    '```crewline-send-attachments',
    JSON.stringify({
      attachments: [{ path: filePath }]
    }),
    '```'
  ].join('\n'), {
    dataDir: path.join(dir, '.runtime')
  });

  assert.equal(result.text, 'README 发你了。');
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].localPath, filePath);
  assert.equal(result.attachments[0].disposition, 'file');
});
