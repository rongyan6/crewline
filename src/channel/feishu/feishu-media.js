import fs from 'node:fs/promises';
import path from 'node:path';

function safeParse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sanitizeSegment(value, fallback = 'file') {
  const normalized = String(value ?? fallback).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return normalized || fallback;
}

function attachmentDateFolder(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function buildStoredFileName({ messageId, messageType, fileName, key }) {
  const extension = fileName ? path.extname(fileName) : '';
  const base = fileName
    ? sanitizeSegment(path.basename(fileName, extension))
    : `${messageType}-${sanitizeSegment(messageId || key)}`;
  return `${base}${extension || (messageType === 'image' ? '.bin' : '')}`;
}

function normalizeMimeType(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.split(';', 1)[0].trim().toLowerCase() || null;
}

function mimeTypeToExtension(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/bmp':
      return '.bmp';
    default:
      return null;
  }
}

function collectBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function extractBufferFromResponse(response) {
  if (Buffer.isBuffer(response)) return response;
  if (response?.data && Buffer.isBuffer(response.data)) return response.data;
  if (response?.data instanceof ArrayBuffer) return Buffer.from(response.data);
  if (response instanceof ArrayBuffer) return Buffer.from(response);
  if (typeof response?.getReadableStream === 'function') {
    return collectBuffer(response.getReadableStream());
  }
  if (typeof response?.data?.getReadableStream === 'function') {
    return collectBuffer(response.data.getReadableStream());
  }
  if (response?.data?.pipe) return collectBuffer(response.data);
  if (response?.pipe) return collectBuffer(response);
  throw new Error('Unable to extract binary data from Feishu response');
}

function detectImageExtensionFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return '.png';
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) return '.gif';
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) return '.webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp';
  return null;
}

function extractMimeTypeFromResponse(response) {
  const direct = normalizeMimeType(response?.headers?.['content-type'] ?? response?.headers?.get?.('content-type'));
  if (direct) return direct;
  return normalizeMimeType(response?.data?.headers?.['content-type'] ?? response?.data?.headers?.get?.('content-type'));
}

function resolveImageFileName({ messageId, fileKey, mimeType, buffer }) {
  const extension = mimeTypeToExtension(mimeType) ?? detectImageExtensionFromBuffer(buffer) ?? '.bin';
  return `image-${sanitizeSegment(messageId || fileKey)}${extension}`;
}

function buildMediaSummary({ kind, caption, localPath, fileName, downloadError }) {
  const lines = [`用户发送了一个 Feishu ${kind === 'image' ? '图片' : '文件'}附件。`];
  if (caption) lines.push(`caption: ${caption}`);
  if (fileName) lines.push(`file_name: ${fileName}`);
  if (localPath) lines.push(`local_path: ${localPath}`);
  if (downloadError) {
    lines.push(`download_error: ${downloadError}`);
    lines.push('附件下载失败，请先提示用户稍后重试。');
  } else {
    lines.push('请先查看本地文件，再继续处理用户请求。');
  }
  return lines.join('\n');
}

function buildLocalFailureReply({ kind, error }) {
  return `Feishu ${kind === 'image' ? '图片' : '文件'}下载失败。\n\n错误：${error}\n请稍后重试。`;
}

function parseFeishuMediaMessage(message) {
  const parsed = safeParse(message?.content);
  if (message?.message_type === 'image' && parsed?.image_key) {
    return {
      kind: 'image',
      resourceType: 'image',
      fileKey: parsed.image_key,
      fileName: undefined
    };
  }
  if (message?.message_type === 'file' && parsed?.file_key) {
    return {
      kind: 'file',
      resourceType: 'file',
      fileKey: parsed.file_key,
      fileName: parsed.file_name
    };
  }
  return null;
}

export async function ingestFeishuMedia({ client, dataDir, message, timestamp }) {
  const media = parseFeishuMediaMessage(message);
  if (!media || !client || !dataDir) return null;
  try {
    const response = await client.im.messageResource.get({
      path: {
        message_id: message.message_id,
        file_key: media.fileKey
      },
      params: {
        type: media.resourceType
      }
    });
    const buffer = await extractBufferFromResponse(response);
    const targetDir = path.join(dataDir, 'attachments', 'feishu', attachmentDateFolder(timestamp));
    await fs.mkdir(targetDir, { recursive: true });
    const mimeType = extractMimeTypeFromResponse(response);
    const fileName = media.kind === 'image'
      ? resolveImageFileName({
          messageId: message.message_id,
          fileKey: media.fileKey,
          mimeType,
          buffer
        })
      : buildStoredFileName({
          messageId: message.message_id,
          messageType: media.kind,
          fileName: media.fileName,
          key: media.fileKey
        });
    const localPath = path.join(targetDir, fileName);
    await fs.writeFile(localPath, buffer);
    return {
      kind: media.kind,
      fileKey: media.fileKey,
      fileName: media.fileName ?? fileName,
      localPath,
      localReplyText: null,
      summaryText: buildMediaSummary({
        kind: media.kind,
        caption: parsedCaption(message),
        localPath,
        fileName: media.fileName ?? fileName
      })
    };
  } catch (error) {
    const errorMessage = error?.message ?? String(error);
    return {
      kind: media.kind,
      fileKey: media.fileKey,
      fileName: media.fileName ?? null,
      localPath: null,
      localReplyText: buildLocalFailureReply({ kind: media.kind, error: errorMessage }),
      summaryText: buildMediaSummary({
        kind: media.kind,
        caption: parsedCaption(message),
        localPath: null,
        fileName: media.fileName,
        downloadError: errorMessage
      })
    };
  }
}

function parsedCaption(message) {
  const parsed = safeParse(message?.content);
  return typeof parsed?.text === 'string' ? parsed.text : '';
}
