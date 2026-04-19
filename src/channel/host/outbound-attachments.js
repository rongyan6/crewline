import fs from 'node:fs/promises';
import path from 'node:path';

const EXTENSION_TO_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
};

function trimToNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeMimeType(mimeType) {
  return trimToNull(mimeType)?.split(';')[0].trim().toLowerCase() ?? null;
}

function getBasenameFromPath(candidatePath) {
  if (!candidatePath) return null;
  if (/^https?:\/\//i.test(candidatePath)) {
    try {
      return path.basename(new URL(candidatePath).pathname);
    } catch {
      return null;
    }
  }
  return path.basename(candidatePath);
}

export function getMimeFromFilename(filename = '') {
  return EXTENSION_TO_MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export function normalizeOutboundAttachment(attachment = {}) {
  const localPath = trimToNull(attachment.localPath);
  if (!localPath) return null;

  const fileName = trimToNull(attachment.fileName) ?? getBasenameFromPath(localPath);
  const mimeType = normalizeMimeType(attachment.mimeType)
    ?? (fileName ? getMimeFromFilename(fileName) : getMimeFromFilename(localPath));
  const normalizedDisposition = trimToNull(
    attachment.disposition
    ?? attachment.presentation
    ?? attachment.kind
  )?.toLowerCase();
  const disposition = normalizedDisposition === 'photo' || normalizedDisposition === 'image' || normalizedDisposition === 'inline_image'
    ? 'image'
    : (mimeType?.startsWith('image/') ? 'image' : 'file');

  return {
    disposition,
    kind: disposition, // Legacy alias for older call sites.
    localPath,
    fileName,
    mimeType
  };
}

export function normalizeOutboundAttachments(attachments = []) {
  return attachments
    .map((attachment) => normalizeOutboundAttachment(attachment))
    .filter(Boolean);
}

export function resolveOutboundAttachments({ attachments = [], meta = {} } = {}) {
  const normalized = normalizeOutboundAttachments(attachments);
  if (normalized.length > 0) return normalized;

  const legacyPath = trimToNull(
    meta?.wechat?.mediaPath
    ?? meta?.wechat?.mediaUrl
    ?? meta?.mediaPath
    ?? meta?.mediaUrl
  );
  if (!legacyPath) return [];

  return normalizeOutboundAttachments([{
    kind: meta?.wechat?.mediaKind ?? meta?.mediaKind ?? null,
    localPath: legacyPath
  }]);
}

function isRuntimeAttachmentCachePath(candidatePath, dataDir) {
  if (!dataDir) return false;
  try {
    const absolutePath = path.resolve(candidatePath);
    const attachmentsRoot = path.resolve(dataDir, 'attachments') + path.sep;
    return absolutePath.startsWith(attachmentsRoot);
  } catch {
    return false;
  }
}

async function validateExtractedAttachment(attachment, { dataDir, allowRuntimeAttachmentPath = false } = {}) {
  const normalized = normalizeOutboundAttachment(attachment);
  if (!normalized) return null;
  if (!path.isAbsolute(normalized.localPath)) return null;
  if (!allowRuntimeAttachmentPath && isRuntimeAttachmentCachePath(normalized.localPath, dataDir)) return null;
  try {
    const stat = await fs.stat(normalized.localPath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  return normalized;
}

function parseStandaloneMarkdownTarget(line, pattern) {
  const match = line.match(pattern);
  if (!match) return null;
  let target = trimToNull(match[1]);
  if (!target) return null;
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }
  if (!target?.startsWith('/')) return null;
  if (/:\d+$/.test(target)) return null;
  return target;
}

async function parseActionBlockAttachments(text, { dataDir } = {}) {
  const blockPattern = /```crewline-send-attachments\s+([\s\S]*?)```/i;
  const match = text.match(blockPattern);
  if (!match) return null;

  let payload = null;
  try {
    payload = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const attachments = [];
  for (const item of payload.attachments ?? []) {
    const attachment = await validateExtractedAttachment({
      localPath: item?.path ?? item?.localPath,
      fileName: item?.fileName,
      mimeType: item?.mimeType,
      disposition: item?.disposition ?? item?.kind
    }, {
      dataDir,
      allowRuntimeAttachmentPath: true
    });
    if (attachment) attachments.push(attachment);
  }

  const remainingText = text.replace(blockPattern, '').trim();
  return {
    text: trimToNull(payload.text) ?? remainingText,
    attachments
  };
}

export async function extractAttachmentsFromText(text, { dataDir } = {}) {
  const sourceText = String(text ?? '');
  if (!sourceText) {
    return { text: '', attachments: [] };
  }

  const actionBlockResult = await parseActionBlockAttachments(sourceText, { dataDir });
  if (actionBlockResult && actionBlockResult.attachments.length > 0) {
    return actionBlockResult;
  }

  const lines = sourceText.split('\n');
  const keptLines = [];
  const attachments = [];
  let pendingMeta = {};
  let pendingLines = [];

  const flushPendingMeta = () => {
    if (pendingLines.length > 0) keptLines.push(...pendingLines);
    pendingMeta = {};
    pendingLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const imageTarget = parseStandaloneMarkdownTarget(trimmed, /^!\[[^\]]*]\((.+)\)$/);
    if (imageTarget) {
      flushPendingMeta();
      const attachment = await validateExtractedAttachment({ localPath: imageTarget, kind: 'image' }, { dataDir });
      if (attachment) {
        attachments.push(attachment);
        continue;
      }
      keptLines.push(line);
      continue;
    }

    const linkTarget = parseStandaloneMarkdownTarget(trimmed, /^\[[^\]]+]\((.+)\)$/);
    if (linkTarget) {
      flushPendingMeta();
      const attachment = await validateExtractedAttachment({ localPath: linkTarget }, { dataDir });
      if (attachment) {
        attachments.push(attachment);
        continue;
      }
      keptLines.push(line);
      continue;
    }

    if (
      trimmed.startsWith('用户发送了一个')
      || trimmed.startsWith('用户发送了一')
      || trimmed.includes('请先查看本地文件，再继续处理用户请求。')
      || trimmed.startsWith('download_error:')
      || trimmed.startsWith('caption:')
      || trimmed.startsWith('file_size_bytes:')
    ) {
      flushPendingMeta();
      keptLines.push(line);
      continue;
    }

    const metadataMatch = trimmed.match(/^(file_name|mime_type|kind):\s*(.+)$/);
    if (metadataMatch) {
      pendingLines.push(line);
      if (metadataMatch[1] === 'file_name') pendingMeta.fileName = metadataMatch[2];
      if (metadataMatch[1] === 'mime_type') pendingMeta.mimeType = metadataMatch[2];
      if (metadataMatch[1] === 'kind') pendingMeta.kind = metadataMatch[2];
      continue;
    }

    const localPathMatch = trimmed.match(/^local_path:\s*(.+)$/);
    if (localPathMatch) {
      const attachment = await validateExtractedAttachment({
        ...pendingMeta,
        localPath: localPathMatch[1]
      }, { dataDir });
      if (attachment) {
        attachments.push(attachment);
        pendingMeta = {};
        pendingLines = [];
        continue;
      }
      flushPendingMeta();
      keptLines.push(line);
      continue;
    }

    flushPendingMeta();
    keptLines.push(line);
  }

  flushPendingMeta();

  return {
    text: keptLines.join('\n').trim(),
    attachments
  };
}
