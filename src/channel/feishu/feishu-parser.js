function parseJsonContent(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function flattenPostParagraphs(content = [], mentionsByOpenId = new Map(), botOpenId) {
  const lines = [];
  for (const paragraph of content) {
    const parts = [];
    for (const element of paragraph ?? []) {
      if (typeof element?.text === 'string') {
        parts.push(element.text);
        continue;
      }
      if (element?.tag === 'at') {
        const userId = element.user_id ?? '';
        if (userId === 'all') {
          parts.push('@all');
          continue;
        }
        if (userId && userId === botOpenId) {
          continue;
        }
        const mention = mentionsByOpenId.get(userId);
        parts.push(`@${mention?.name ?? element.user_name ?? userId}`);
        continue;
      }
      if (typeof element?.content === 'string') {
        parts.push(element.content);
      }
    }
    const line = parts.join('').trim();
    if (line) lines.push(line);
  }
  return lines;
}

function extractPostText(parsed, mentionsByOpenId, botOpenId) {
  if (parsed?.title && typeof parsed.title === 'string') {
    const lines = [parsed.title];
    lines.push(...flattenPostParagraphs(parsed.content ?? [], mentionsByOpenId, botOpenId));
    return lines.join('\n').trim();
  }

  for (const localeValue of Object.values(parsed ?? {})) {
    if (!localeValue || typeof localeValue !== 'object') continue;
    const title = typeof localeValue.title === 'string' ? localeValue.title : '';
    const lines = flattenPostParagraphs(localeValue.content ?? [], mentionsByOpenId, botOpenId);
    const text = [title, ...lines].filter(Boolean).join('\n').trim();
    if (text) return text;
  }

  return '';
}

function normalizeTextMentions(text, mentions = [], botOpenId) {
  let output = text;
  for (const mention of mentions) {
    const key = mention?.key;
    if (!key) continue;
    if (mention.id?.open_id === botOpenId) {
      output = output.replaceAll(key, '');
      continue;
    }
    if (key === '@_all') {
      output = output.replaceAll(key, '@all');
      continue;
    }
    const replacement = mention?.name ? `@${mention.name}` : '';
    output = output.replaceAll(key, replacement);
  }
  return output.trim();
}

export function parseFeishuMessageText(message, { botOpenId } = {}) {
  if (!message?.message_type) return '';
  const parsed = parseJsonContent(message.content);
  const mentions = message.mentions ?? [];
  const mentionsByOpenId = new Map(
    mentions
      .filter((mention) => mention?.id?.open_id)
      .map((mention) => [mention.id.open_id, mention])
  );

  switch (message.message_type) {
    case 'text':
      return typeof parsed.text === 'string'
        ? normalizeTextMentions(parsed.text.trim(), mentions, botOpenId)
        : '';
    case 'post':
      return extractPostText(parsed, mentionsByOpenId, botOpenId);
    default:
      return '';
  }
}

export function resolveUnsupportedFeishuReply(messageType) {
  return `暂不支持的飞书消息类型：${messageType}。\n\n当前仅支持：text、post、image、file。`;
}
