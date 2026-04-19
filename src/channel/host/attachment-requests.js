import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeOutboundAttachments } from './outbound-attachments.js';

const SEND_VERB_PATTERN = /(发给我|发我|发送给我|发送到当前聊天|传给我|传我|回传|把.*给我|send me|send (?:the )?(?:file|image|photo|attachment))/i;
const ATTACHMENT_OBJECT_PATTERN = /(文件|附件|图片|截图|照片|压缩包|pdf|png|jpg|jpeg|gif|webp|readme|file|attachment|image|photo)/i;
const CONTENT_INTENT_PATTERN = /(内容|总结|概括|摘要|分析|解释|翻译|阅读|读一下|看看|看下|打开|预览|\bsummari[sz]e\b|\bsummary\b|\banaly[sz]e\b|\bexplain\b|\bread\b|\bpreview\b|\bopen\b)/i;
const MARKDOWN_MEDIA_PATTERN = /!\[[^\]]*]\((.+)\)|\[[^\]]+]\((.+)\)/g;
const QUOTED_PATH_PATTERN = /(["'`])((?:\/[^"'`\n]+)+)\1/g;
const EXACT_PATH_WITH_EXTENSION_PATTERN = /((?:\/[^/\s"'`<>]+)+\.(?:pdf|docx?|xlsx?|pptx?|txt|md|csv|json|zip|tar|gz|png|jpe?g|gif|webp|bmp|svg|mp3|ogg|wav|mp4|mov|webm))/ig;
const RAW_PATH_PATTERN = /(?:^|[\s(（"'`])((?:\/[^\s)）"'`]+)+)/g;
const KNOWN_EXTENSION_PATTERN = /\.(?:pdf|docx?|xlsx?|pptx?|txt|md|csv|json|zip|tar|gz|png|jpe?g|gif|webp|bmp|svg|mp3|ogg|wav|mp4|mov|webm)(?=$|[^a-z0-9])/i;

function buildRuntimeAttachmentPrompt(originalText) {
  return [
    '用户请求你把某个本地文件或图片发送回当前聊天。',
    '如果你判断用户是在请求发送附件，而不是阅读/总结内容，请不要粘贴文件内容。',
    '先解析出最合适的本地绝对路径；如果足够确定，就在答复末尾追加一个动作块：',
    '```crewline-send-attachments',
    '{"text":"可选，发给用户的简短说明","attachments":[{"path":"/absolute/path/to/file"}]}',
    '```',
    '规则：',
    '- 统一使用 attachments[]，不要单独输出 image 字段',
    '- 路径必须是本地绝对路径',
    '- 图片也是 attachments[] 里的一个元素',
    '- 如果不确定路径或候选不止一个，不要输出动作块，直接向用户澄清',
    '- 如果用户其实想看内容/总结/分析，也不要输出动作块',
    '',
    `用户原始请求：${originalText}`
  ].join('\n');
}

function collectMatches(text, pattern, index = 1) {
  const matches = [];
  let match = null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[index] || match[index + 1];
    if (value) matches.push(String(value).trim());
  }
  pattern.lastIndex = 0;
  return matches;
}

function sanitizeLocalPathCandidate(candidate = '') {
  let sanitized = String(candidate).trim().replace(/[>,，。！？；：]+$/u, '');
  const extensionMatch = KNOWN_EXTENSION_PATTERN.exec(sanitized);
  if (extensionMatch) {
    sanitized = sanitized.slice(0, extensionMatch.index + extensionMatch[0].length);
  }
  return sanitized;
}

function collectLocalPathCandidates(text = '') {
  const candidates = new Set();
  for (const value of collectMatches(text, MARKDOWN_MEDIA_PATTERN, 1)) {
    let target = value;
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1).trim();
    }
    if (target.startsWith('/')) candidates.add(sanitizeLocalPathCandidate(target));
  }
  for (const value of collectMatches(text, QUOTED_PATH_PATTERN, 2)) {
    if (value.startsWith('/')) candidates.add(sanitizeLocalPathCandidate(value));
  }
  for (const value of collectMatches(text, EXACT_PATH_WITH_EXTENSION_PATTERN, 1)) {
    if (value.startsWith('/')) candidates.add(sanitizeLocalPathCandidate(value));
  }
  for (const value of collectMatches(text, RAW_PATH_PATTERN, 1)) {
    if (value.startsWith('/')) candidates.add(sanitizeLocalPathCandidate(value));
  }
  return [...candidates];
}

async function validateDirectPathCandidates(candidates = []) {
  const attachments = [];
  for (const candidate of candidates) {
    const resolvedPath = path.resolve(candidate);
    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat?.isFile()) continue;
    attachments.push({ localPath: resolvedPath });
  }
  return normalizeOutboundAttachments(attachments);
}

export async function resolveAttachmentRequest(text = '') {
  const sourceText = String(text ?? '');
  if (!sourceText.trim()) {
    return {
      mode: 'none',
      attachments: [],
      runtimeMessageText: sourceText
    };
  }

  const hasSendVerb = SEND_VERB_PATTERN.test(sourceText);
  const hasAttachmentObject = ATTACHMENT_OBJECT_PATTERN.test(sourceText);
  const wantsContent = CONTENT_INTENT_PATTERN.test(sourceText) && !/发给我|发我|传给我|传我|send me/i.test(sourceText);

  if (!(hasSendVerb && (hasAttachmentObject || sourceText.includes('/'))) || wantsContent) {
    return {
      mode: 'none',
      attachments: [],
      runtimeMessageText: sourceText
    };
  }

  const directAttachments = await validateDirectPathCandidates(collectLocalPathCandidates(sourceText));
  if (directAttachments.length > 0) {
    return {
      mode: 'direct',
      attachments: directAttachments,
      runtimeMessageText: sourceText
    };
  }

  return {
    mode: 'agent',
    attachments: [],
    runtimeMessageText: buildRuntimeAttachmentPrompt(sourceText)
  };
}
