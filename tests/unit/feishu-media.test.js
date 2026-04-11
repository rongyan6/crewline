import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ingestFeishuMedia } from '../../src/channel/feishu/feishu-media.js';

test('ingestFeishuMedia downloads image to daily cache directory', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-media-'));
  const client = {
    im: {
      messageResource: {
        async get() {
          return {
            headers: { 'content-type': 'image/png' },
            data: Buffer.from('image-bytes')
          };
        }
      }
    }
  };
  const result = await ingestFeishuMedia({
    client,
    dataDir,
    message: {
      message_id: 'om_1',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_1' })
    },
    timestamp: '2026-04-08T12:00:00.000Z'
  });
  assert.equal(result.localReplyText, null);
  assert.match(result.summaryText, /local_path:/);
  assert.equal(result.localPath.endsWith(path.join('attachments', 'feishu', '2026-04-08', 'image-om_1.png')), true);
  assert.equal(await fs.readFile(result.localPath, 'utf8'), 'image-bytes');
});

test('ingestFeishuMedia downloads file to daily cache directory', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-file-'));
  const client = {
    im: {
      messageResource: {
        async get() {
          return { data: Buffer.from('file-bytes') };
        }
      }
    }
  };
  const result = await ingestFeishuMedia({
    client,
    dataDir,
    message: {
      message_id: 'om_2',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_1', file_name: 'report.md' })
    },
    timestamp: '2026-04-08T12:00:00.000Z'
  });
  assert.equal(result.localReplyText, null);
  assert.equal(result.localPath.endsWith(path.join('attachments', 'feishu', '2026-04-08', 'report.md')), true);
});

test('ingestFeishuMedia accepts Feishu SDK resource objects with getReadableStream', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-stream-'));
  const client = {
    im: {
      messageResource: {
        async get() {
          return {
            getReadableStream() {
              return Readable.from([Buffer.from('stream-bytes')]);
            }
          };
        }
      }
    }
  };
  const result = await ingestFeishuMedia({
    client,
    dataDir,
    message: {
      message_id: 'om_3',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_stream' })
    },
    timestamp: '2026-04-08T12:00:00.000Z'
  });

  assert.equal(result.localReplyText, null);
  assert.equal(await fs.readFile(result.localPath, 'utf8'), 'stream-bytes');
});

test('ingestFeishuMedia detects image extension from file signature when headers are missing', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-feishu-signature-'));
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d
  ]);
  const client = {
    im: {
      messageResource: {
        async get() {
          return pngBytes;
        }
      }
    }
  };
  const result = await ingestFeishuMedia({
    client,
    dataDir,
    message: {
      message_id: 'om_sig_1',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_sig' })
    },
    timestamp: '2026-04-08T12:00:00.000Z'
  });

  assert.equal(result.localPath.endsWith(path.join('attachments', 'feishu', '2026-04-08', 'image-om_sig_1.png')), true);
});
