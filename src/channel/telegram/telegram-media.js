import fs from 'node:fs/promises';
import path from 'node:path';

function sanitizeSegment(value, fallback = 'file') {
  const normalized = String(value ?? fallback).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return normalized || fallback;
}

function attachmentDateFolder(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function pickLargestPhoto(photos = []) {
  return [...photos].sort((left, right) => {
    const leftScore = Number(left.file_size ?? 0) || (Number(left.width ?? 0) * Number(left.height ?? 0));
    const rightScore = Number(right.file_size ?? 0) || (Number(right.width ?? 0) * Number(right.height ?? 0));
    return rightScore - leftScore;
  })[0] ?? null;
}

function extensionFromPath(filePath) {
  const ext = path.extname(filePath ?? '').trim();
  return ext || '';
}

function ensureExtension(filename, fallbackExtension) {
  if (path.extname(filename)) return filename;
  return `${filename}${fallbackExtension || ''}`;
}

function buildStoredFileName({ messageId, kind, filePath, fileName }) {
  const preferredBase = fileName
    ? sanitizeSegment(path.basename(fileName, path.extname(fileName)))
    : `${kind}-${sanitizeSegment(messageId)}`;
  return ensureExtension(preferredBase, extensionFromPath(filePath) || (kind === 'photo' ? '.jpg' : ''));
}

function createAttachmentSummary({ kind, caption, localPath, fileName, mimeType, fileSize, downloadError }) {
  const lines = [`用户发送了一个 Telegram ${kind === 'photo' ? '图片' : '文件'}附件。`];
  if (caption) lines.push(`caption: ${caption}`);
  if (fileName) lines.push(`file_name: ${fileName}`);
  if (mimeType) lines.push(`mime_type: ${mimeType}`);
  if (typeof fileSize === 'number') lines.push(`file_size_bytes: ${fileSize}`);
  if (localPath) lines.push(`local_path: ${localPath}`);
  if (downloadError) {
    lines.push(`download_error: ${downloadError}`);
    lines.push('附件下载失败，请先告诉用户重试或改发更小的文件。');
  } else {
    lines.push('请先查看本地文件，再继续处理用户请求。');
  }
  return lines.join('\n');
}

function createProxyDiagnostic(api, stage) {
  return {
    stage,
    proxyConfigured: Boolean(api?.proxy),
    proxy: sanitizeProxyForUser(api?.proxy)
  };
}

function sanitizeProxyForUser(proxy) {
  if (!proxy) return null;
  try {
    const parsed = new URL(proxy);
    return parsed.origin;
  } catch {
    return '[configured]';
  }
}

function createDownloadFailureReply({ attachment, proxyDiagnostic }) {
  const lines = [
    '附件下载失败，当前没有拿到可供 agent 处理的本地文件。'
  ];
  if (attachment.caption) lines.push(`caption: ${attachment.caption}`);
  if (attachment.fileName) lines.push(`file_name: ${attachment.fileName}`);
  if (attachment.downloadError) lines.push(`download_error: ${attachment.downloadError}`);
  lines.push(`proxy_configured: ${proxyDiagnostic.proxyConfigured ? 'yes' : 'no'}`);
  lines.push(`proxy_stage: ${proxyDiagnostic.stage}`);
  if (proxyDiagnostic.proxy) lines.push(`proxy: ${proxyDiagnostic.proxy}`);
  lines.push('');
  lines.push('建议：');
  lines.push('- 先确认代理当前可用');
  lines.push('- 重试发送该附件');
  lines.push('- 若仍失败，可换更小文件，或直接发送文本内容');
  return lines.join('\n');
}

function createUnsupportedReply(kind) {
  return `暂不支持的消息类型：${kind}。\n\n当前仅支持：文本、图片(photo)、文件(document)。`;
}

function createDescriptor(base, overrides = {}) {
  return {
    kind: base.kind,
    fileId: base.fileId,
    fileUniqueId: base.fileUniqueId ?? null,
    fileSize: base.fileSize ?? null,
    fileName: base.fileName ?? null,
    mimeType: base.mimeType ?? null,
    telegramFilePath: base.telegramFilePath ?? null,
    localPath: base.localPath ?? null,
    caption: base.caption ?? '',
    downloadError: base.downloadError ?? null,
    ...overrides
  };
}

async function downloadTelegramFile({ api, dataDir, timestamp, messageId, attachment }) {
  const file = await api.getFile(attachment.fileId);
  if (!file?.file_path) {
    return createDescriptor(attachment, {
      downloadError: 'Telegram getFile did not return file_path'
    });
  }

  const bytes = await api.downloadFile(file.file_path);
  const targetDir = path.join(dataDir, 'attachments', 'telegram', attachmentDateFolder(timestamp));
  await fs.mkdir(targetDir, { recursive: true });
  const storedName = buildStoredFileName({
    messageId,
    kind: attachment.kind,
    filePath: file.file_path,
    fileName: attachment.fileName
  });
  const localPath = path.join(targetDir, storedName);
  await fs.writeFile(localPath, bytes);
  return createDescriptor(attachment, {
    telegramFilePath: file.file_path,
    localPath
  });
}

function detectAttachment(message) {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = pickLargestPhoto(message.photo);
    if (!photo?.file_id) return null;
    return createDescriptor({
      kind: 'photo',
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      fileSize: photo.file_size,
      caption: message.caption ?? ''
    });
  }

  if (message.document?.file_id) {
    return createDescriptor({
      kind: 'document',
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      fileSize: message.document.file_size,
      fileName: message.document.file_name,
      mimeType: message.document.mime_type,
      caption: message.caption ?? ''
    });
  }

  return null;
}

function detectUnsupportedMessageKind(message) {
  if (message.sticker) return 'sticker';
  if (message.voice) return 'voice';
  if (message.audio) return 'audio';
  if (message.video) return 'video';
  if (message.video_note) return 'video_note';
  if (message.animation) return 'animation';
  if (message.contact) return 'contact';
  if (message.location) return 'location';
  if (message.poll) return 'poll';
  return null;
}

export async function ingestTelegramAttachment({ api, dataDir, message, timestamp }) {
  const attachment = detectAttachment(message);
  if (!attachment || !api || !dataDir) return null;
  try {
    return await downloadTelegramFile({
      api,
      dataDir,
      timestamp,
      messageId: message.message_id,
      attachment
    });
  } catch (error) {
    return createDescriptor(attachment, {
      downloadError: error?.message ?? String(error),
      proxyDiagnostic: createProxyDiagnostic(api, 'download_exception')
    });
  }
}

export async function resolveTelegramInboundHandling({ api, dataDir, message, timestamp }) {
  const attachment = await ingestTelegramAttachment({ api, dataDir, message, timestamp });
  if (attachment) {
    if (attachment.downloadError) {
      const proxyDiagnostic = attachment.proxyDiagnostic ?? createProxyDiagnostic(api, attachment.telegramFilePath ? 'download' : 'get_file');
      return {
        attachment: {
          ...attachment,
          proxyDiagnostic
        },
        localReplyText: createDownloadFailureReply({
          attachment,
          proxyDiagnostic
        })
      };
    }
    return { attachment, localReplyText: null };
  }

  const unsupportedKind = detectUnsupportedMessageKind(message);
  if (unsupportedKind) {
    return {
      attachment: null,
      localReplyText: createUnsupportedReply(unsupportedKind)
    };
  }

  return {
    attachment: null,
    localReplyText: null
  };
}

export function buildTelegramInboundText({ message, attachment }) {
  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text;
  }

  if (attachment) {
    return createAttachmentSummary({
      kind: attachment.kind,
      caption: attachment.caption,
      localPath: attachment.localPath,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      downloadError: attachment.downloadError
    });
  }

  if (typeof message.caption === 'string' && message.caption.trim()) {
    return message.caption;
  }

  return '';
}
