import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildWechatInboundText,
  ingestWechatAttachment,
  sendWechatMediaFile
} from '../../src/channel/wechat/wechat-media.js';

function createBufferResponse(buffer, { headers = {}, status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      }
    },
    async arrayBuffer() {
      return buffer;
    }
  };
}

test('ingestWechatAttachment downloads and decrypts file attachment to local path', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-media-'));
  const key = Buffer.from('0123456789abcdef', 'utf8');
  const plaintext = Buffer.from('wechat-file');
  const { createCipheriv } = await import('node:crypto');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const attachment = await ingestWechatAttachment({
    cdnBaseUrl: 'https://cdn-wechat.example',
    dataDir,
    timestamp: '2026-04-09T09:00:00.000Z',
    message: {
      message_id: 10,
      item_list: [{
        type: 4,
        file_item: {
          file_name: 'report.pdf',
          len: String(plaintext.length),
          media: {
            full_url: 'https://cdn-wechat.example/file',
            aes_key: key.toString('base64')
          }
        }
      }]
    },
    fetchImpl: async () => createBufferResponse(encrypted)
  });

  assert.equal(attachment.kind, 'file');
  assert.equal(await fs.readFile(attachment.localPath, 'utf8'), 'wechat-file');
  const text = buildWechatInboundText({ message: {}, attachment });
  assert.match(text, /微信文件附件/);
  assert.match(text, /local_path:/);
});

test('sendWechatMediaFile uploads image and sends message item payload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-wechat-outbound-'));
  const filePath = path.join(dir, 'image.png');
  await fs.writeFile(filePath, 'image-bytes', 'utf8');
  const fetchCalls = [];
  const api = {
    async getUploadUrl() {
      return {
        upload_param: 'upload-token'
      };
    },
    async sendMessage(body) {
      fetchCalls.push(body);
      return {};
    }
  };

  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
    return {
      status: 200,
      statusText: 'OK',
      headers: {
        get(name) {
          return name.toLowerCase() === 'x-encrypted-param' ? 'download-token' : null;
        }
      }
    };
  };

  const result = await sendWechatMediaFile({
    api,
    cdnBaseUrl: 'https://cdn-wechat.example',
    to: 'wxid_alice',
    text: 'caption',
    contextToken: 'ctx-1',
    filePath,
    fetchImpl
  });

  assert.equal(result.ok, true);
  assert.equal(fetchCalls[1].msg.to_user_id, 'wxid_alice');
  assert.equal(fetchCalls[1].msg.item_list[0].text_item.text, 'caption');
  assert.equal(fetchCalls[1].msg.item_list[1].type, 2);
});

test('sendWechatMediaFile rejects remote media URLs by default', async () => {
  const api = {
    async getUploadUrl() {
      throw new Error('should not request upload url');
    },
    async sendMessage() {
      throw new Error('should not send message');
    }
  };

  await assert.rejects(
    sendWechatMediaFile({
      api,
      cdnBaseUrl: 'https://cdn-wechat.example',
      to: 'wxid_alice',
      filePath: 'https://files.example/image.png',
      fetchImpl: async () => createBufferResponse(Buffer.from('image-bytes'))
    }),
    /disabled by default/
  );
});

test('sendWechatMediaFile allows remote https media URLs only when explicitly enabled', async () => {
  const fetchCalls = [];
  const api = {
    async getUploadUrl() {
      return {
        upload_param: 'upload-token'
      };
    },
    async sendMessage(body) {
      fetchCalls.push(body);
      return {};
    }
  };

  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (!init) {
      return createBufferResponse(Buffer.from('image-bytes'), {
        headers: { 'content-type': 'image/png' }
      });
    }
    return {
      status: 200,
      statusText: 'OK',
      headers: {
        get(name) {
          return name.toLowerCase() === 'x-encrypted-param' ? 'download-token' : null;
        }
      }
    };
  };

  const result = await sendWechatMediaFile({
    api,
    cdnBaseUrl: 'https://cdn-wechat.example',
    to: 'wxid_alice',
    filePath: 'https://files.example/image.png',
    allowRemoteUrl: true,
    fetchImpl
  });

  assert.equal(result.ok, true);
  assert.equal(fetchCalls[0].url, 'https://files.example/image.png');
  assert.equal(fetchCalls[2].msg.to_user_id, 'wxid_alice');
});
