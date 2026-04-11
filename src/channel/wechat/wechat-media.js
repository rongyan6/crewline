import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv } from 'node:crypto';

function sanitizeSegment(value, fallback = 'file') {
  const normalized = String(value ?? fallback).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return normalized || fallback;
}

function attachmentDateFolder(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

const EXTENSION_TO_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.silk': 'audio/silk'
};

function getMimeFromFilename(filename = '') {
  return EXTENSION_TO_MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function getExtensionFromMime(mimeType = '') {
  const normalized = String(mimeType).split(';')[0].trim().toLowerCase();
  const match = Object.entries(EXTENSION_TO_MIME).find(([, value]) => value === normalized);
  return match?.[0] ?? '.bin';
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

function validateRemoteMediaUrl(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.trim().toLowerCase();
  if (parsed.protocol !== 'https:') {
    throw new Error('remote media URL must use https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('remote media URL must not embed credentials');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('remote media URL must not target localhost');
  }
  const ipVersion = net.isIP(hostname);
  if ((ipVersion === 4 && isPrivateIpv4(hostname)) || (ipVersion === 6 && isPrivateIpv6(hostname))) {
    throw new Error('remote media URL must not target a private IP address');
  }
  return parsed;
}

function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function buildCdnUploadUrl(uploadParam, filekey, cdnBaseUrl) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16;
}

function parseAesKey(aesKeyBase64, label) {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`${label}: invalid aes_key encoding`);
}

async function fetchBuffer(url, { fetchImpl = fetch, label = 'fetchBuffer' } = {}) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`${label}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function buildStoredFileName({ messageId, kind, fileName, mimeType }) {
  const extension = fileName ? path.extname(fileName) : getExtensionFromMime(mimeType);
  const base = fileName
    ? sanitizeSegment(path.basename(fileName, path.extname(fileName)))
    : `${kind}-${sanitizeSegment(messageId || crypto.randomUUID())}`;
  return `${base}${extension || '.bin'}`;
}

function createMediaDescriptor(base, overrides = {}) {
  return {
    kind: base.kind,
    fileName: base.fileName ?? null,
    mimeType: base.mimeType ?? null,
    localPath: base.localPath ?? null,
    fileSize: base.fileSize ?? null,
    downloadError: base.downloadError ?? null,
    ...overrides
  };
}

function createWechatAttachmentSummary({ kind, localPath, fileName, mimeType, fileSize, downloadError }) {
  const label = kind === 'image'
    ? '图片'
    : kind === 'video'
      ? '视频'
      : kind === 'voice'
        ? '语音'
        : '文件';
  const lines = [`用户发送了一个微信${label}附件。`];
  if (fileName) lines.push(`file_name: ${fileName}`);
  if (mimeType) lines.push(`mime_type: ${mimeType}`);
  if (typeof fileSize === 'number') lines.push(`file_size_bytes: ${fileSize}`);
  if (localPath) lines.push(`local_path: ${localPath}`);
  if (downloadError) {
    lines.push(`download_error: ${downloadError}`);
    lines.push('附件下载失败，请先提示用户稍后重试。');
  } else {
    lines.push('请先查看本地文件，再继续处理用户请求。');
  }
  return lines.join('\n');
}

function detectWechatAttachment(message) {
  const itemList = message?.item_list ?? [];
  for (const item of itemList) {
    if (item?.type === 2 && item.image_item?.media) {
      return {
        kind: 'image',
        media: item.image_item.media,
        aeskey: item.image_item.aeskey
          ? Buffer.from(item.image_item.aeskey, 'hex').toString('base64')
          : item.image_item.media.aes_key,
        fileName: null,
        mimeType: 'image/*',
        fileSize: item.image_item.mid_size ?? item.image_item.hd_size ?? null
      };
    }
    if (item?.type === 5 && item.video_item?.media) {
      return {
        kind: 'video',
        media: item.video_item.media,
        aeskey: item.video_item.media.aes_key,
        fileName: null,
        mimeType: 'video/mp4',
        fileSize: item.video_item.video_size ?? null
      };
    }
    if (item?.type === 4 && item.file_item?.media) {
      return {
        kind: 'file',
        media: item.file_item.media,
        aeskey: item.file_item.media.aes_key,
        fileName: item.file_item.file_name ?? null,
        mimeType: getMimeFromFilename(item.file_item.file_name ?? 'file.bin'),
        fileSize: Number(item.file_item.len ?? 0) || null
      };
    }
    if (item?.type === 3 && item.voice_item?.media) {
      return {
        kind: 'voice',
        media: item.voice_item.media,
        aeskey: item.voice_item.media.aes_key,
        fileName: null,
        mimeType: 'audio/silk',
        fileSize: null
      };
    }
  }
  return null;
}

async function downloadAttachmentBuffer({ attachment, cdnBaseUrl, fetchImpl }) {
  const fullUrl = attachment.media?.full_url;
  const encryptedQueryParam = attachment.media?.encrypt_query_param;
  const url = fullUrl || buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  const encrypted = await fetchBuffer(url, {
    fetchImpl,
    label: `wechat.${attachment.kind}.download`
  });
  if (!attachment.aeskey) return encrypted;
  return decryptAesEcb(encrypted, parseAesKey(attachment.aeskey, `wechat.${attachment.kind}`));
}

export async function ingestWechatAttachment({
  cdnBaseUrl,
  dataDir,
  message,
  timestamp,
  fetchImpl = fetch
}) {
  const attachment = detectWechatAttachment(message);
  if (!attachment || !dataDir) return null;
  try {
    const buffer = await downloadAttachmentBuffer({ attachment, cdnBaseUrl, fetchImpl });
    const targetDir = path.join(dataDir, 'attachments', 'wechat', attachmentDateFolder(timestamp));
    await fs.mkdir(targetDir, { recursive: true });
    const fileName = buildStoredFileName({
      messageId: message?.message_id ?? message?.seq,
      kind: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType ?? undefined
    });
    const localPath = path.join(targetDir, fileName);
    await fs.writeFile(localPath, buffer);
    return createMediaDescriptor(attachment, {
      fileName,
      localPath,
      fileSize: buffer.length
    });
  } catch (error) {
    return createMediaDescriptor(attachment, {
      downloadError: error?.message ?? String(error)
    });
  }
}

export function buildWechatInboundText({ message, attachment }) {
  const itemList = message?.item_list ?? [];
  for (const item of itemList) {
    if (item?.type === 1 && item.text_item?.text) return String(item.text_item.text);
    if (item?.type === 3 && item.voice_item?.text) return String(item.voice_item.text);
  }
  if (attachment) {
    return createWechatAttachmentSummary({
      kind: attachment.kind,
      localPath: attachment.localPath,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      downloadError: attachment.downloadError
    });
  }
  return '';
}

async function downloadRemoteMediaToTemp(url, destDir, { fetchImpl = fetch } = {}) {
  const parsed = validateRemoteMediaUrl(url);
  const response = await fetchImpl(parsed);
  if (!response.ok) {
    throw new Error(`remote media download failed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(destDir, { recursive: true });
  const ext = getExtensionFromMime(response.headers.get?.('content-type') ?? '') || path.extname(parsed.pathname) || '.bin';
  const filePath = path.join(destDir, `wechat-remote-${crypto.randomUUID()}${ext}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function uploadBufferToCdn({ buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey, fetchImpl = fetch }) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const url = uploadFullUrl?.trim() || buildCdnUploadUrl(uploadParam, filekey, cdnBaseUrl);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext)
  });
  if (response.status >= 400) {
    throw new Error(`CDN upload failed: ${response.status} ${response.statusText}`);
  }
  const downloadParam = response.headers.get('x-encrypted-param');
  if (!downloadParam) {
    throw new Error('CDN upload response missing x-encrypted-param');
  }
  return { downloadParam };
}

function createTextItem(text) {
  return {
    type: 1,
    text_item: { text }
  };
}

function getUploadMediaType(mimeType) {
  if (mimeType.startsWith('image/')) return 1;
  if (mimeType.startsWith('video/')) return 2;
  return 3;
}

export async function uploadWechatMedia({
  api,
  cdnBaseUrl,
  toUserId,
  filePath,
  fileName,
  mimeType,
  fetchImpl = fetch
}) {
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);
  const uploadUrl = await api.getUploadUrl({
    filekey,
    media_type: getUploadMediaType(mimeType),
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex')
  });
  const uploaded = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadUrl.upload_full_url,
    uploadParam: uploadUrl.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
    fetchImpl
  });
  return {
    filekey,
    downloadEncryptedQueryParam: uploaded.downloadParam,
    aeskey: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
    fileName
  };
}

export async function sendWechatMediaFile({
  api,
  cdnBaseUrl,
  to,
  text = '',
  contextToken,
  filePath,
  allowRemoteUrl = false,
  fetchImpl = fetch
}) {
  let resolvedPath = filePath;
  if (/^https?:\/\//.test(filePath)) {
    if (!allowRemoteUrl) {
      throw new Error('remote media URLs are disabled by default');
    }
    resolvedPath = await downloadRemoteMediaToTemp(filePath, path.join(os.tmpdir(), 'crewline-wechat-outbound'), { fetchImpl });
  }
  const fileName = path.basename(resolvedPath);
  const mimeType = getMimeFromFilename(fileName);
  const uploaded = await uploadWechatMedia({
    api,
    cdnBaseUrl,
    toUserId: to,
    filePath: resolvedPath,
    fileName,
    mimeType,
    fetchImpl
  });

  const items = [];
  if (text) items.push(createTextItem(text));
  if (mimeType.startsWith('image/')) {
    items.push({
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, 'hex').toString('base64'),
          encrypt_type: 1
        },
        mid_size: uploaded.fileSizeCiphertext
      }
    });
  } else if (mimeType.startsWith('video/')) {
    items.push({
      type: 5,
      video_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, 'hex').toString('base64'),
          encrypt_type: 1
        },
        video_size: uploaded.fileSizeCiphertext
      }
    });
  } else {
    items.push({
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, 'hex').toString('base64'),
          encrypt_type: 1
        },
        file_name: uploaded.fileName,
        len: String(uploaded.fileSize)
      }
    });
  }

  const clientId = `crewline-wechat-${crypto.randomUUID()}`;
  await api.sendMessage({
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: items,
      context_token: contextToken
    }
  });
  return { ok: true, messageId: clientId, target: to };
}
