import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildTelegramInboundText,
  ingestTelegramAttachment,
  resolveTelegramInboundHandling
} from '../../src/channel/telegram/telegram-media.js';

test('ingestTelegramAttachment downloads largest photo and builds runtime-friendly summary', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-tg-media-'));
  const api = {
    async getFile(fileId) {
      assert.equal(fileId, 'photo-large');
      return { file_path: 'photos/file_123.jpg' };
    },
    async downloadFile(filePath) {
      assert.equal(filePath, 'photos/file_123.jpg');
      return Buffer.from('image-bytes');
    }
  };

  const attachment = await ingestTelegramAttachment({
    api,
    dataDir,
    timestamp: '2026-04-08T09:00:00.000Z',
    message: {
      message_id: 10,
      caption: '看看这张图',
      photo: [
        { file_id: 'photo-small', width: 90, height: 90, file_size: 2000 },
        { file_id: 'photo-large', width: 1280, height: 720, file_size: 9000 }
      ]
    }
  });

  assert.equal(attachment.kind, 'photo');
  assert.equal(attachment.downloadError, null);
  assert.equal(attachment.localPath.endsWith(path.join('attachments', 'telegram', '2026-04-08', 'photo-10.jpg')), true);
  assert.equal(await fs.readFile(attachment.localPath, 'utf8'), 'image-bytes');

  const text = buildTelegramInboundText({ message: { caption: '看看这张图' }, attachment });
  assert.match(text, /图片附件/);
  assert.match(text, /caption: 看看这张图/);
  assert.match(text, /local_path:/);
});

test('ingestTelegramAttachment preserves document metadata and surfaces download failures', async () => {
  const attachment = await ingestTelegramAttachment({
    api: {
      async getFile() {
        throw new Error('proxy timeout');
      }
    },
    dataDir: '/tmp/crewline',
    timestamp: '2026-04-08T09:00:00.000Z',
    message: {
      message_id: 20,
      caption: '请看附件',
      document: {
        file_id: 'doc-1',
        file_unique_id: 'uq-1',
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
        file_size: 1234
      }
    }
  });

  assert.equal(attachment.kind, 'document');
  assert.equal(attachment.fileName, 'report.pdf');
  assert.equal(attachment.mimeType, 'application/pdf');
  assert.equal(attachment.downloadError, 'proxy timeout');

  const text = buildTelegramInboundText({ message: { caption: '请看附件' }, attachment });
  assert.match(text, /文件附件/);
  assert.match(text, /download_error: proxy timeout/);
});

test('resolveTelegramInboundHandling emits local reply for download failure with proxy diagnostics', async () => {
  const result = await resolveTelegramInboundHandling({
    api: {
      proxy: 'http://user:secret@127.0.0.1:29758/private',
      async getFile() {
        return { file_path: 'docs/report.pdf' };
      },
      async downloadFile() {
        throw new Error('tls handshake failed');
      }
    },
    dataDir: '/tmp/crewline',
    timestamp: '2026-04-08T09:00:00.000Z',
    message: {
      message_id: 30,
      caption: '失败文件',
      document: {
        file_id: 'doc-2',
        file_name: 'report.pdf'
      }
    }
  });

  assert.match(result.localReplyText, /附件下载失败/);
  assert.match(result.localReplyText, /proxy_configured: yes/);
  assert.doesNotMatch(result.localReplyText, /secret/);
  assert.match(result.localReplyText, /proxy: http:\/\/127.0.0.1:29758/);
});

test('resolveTelegramInboundHandling emits local reply for unsupported message types', async () => {
  const result = await resolveTelegramInboundHandling({
    api: {},
    dataDir: '/tmp/crewline',
    timestamp: '2026-04-08T09:00:00.000Z',
    message: {
      message_id: 31,
      sticker: { file_id: 'sticker-1' }
    }
  });

  assert.equal(result.attachment, null);
  assert.match(result.localReplyText, /暂不支持的消息类型：sticker/);
});
