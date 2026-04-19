const TELEGRAM_MAX_TEXT_LENGTH = 4096;

function buildTelegramAttachmentMeta(meta = {}) {
  const attachmentMeta = {};
  if (meta.parse_mode) attachmentMeta.parse_mode = meta.parse_mode;
  if (meta.protect_content !== undefined) attachmentMeta.protect_content = meta.protect_content;
  return attachmentMeta;
}

export function splitText(text, maxLength = TELEGRAM_MAX_TEXT_LENGTH) {
  if (text.length <= maxLength) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength * 0.5) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < maxLength * 0.3) splitAt = maxLength;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return parts;
}

export async function sendTelegramMessage(api, outboundMessage) {
  const chatId = outboundMessage.conversationRef.conversationId;
  const fallbackThreadId = outboundMessage.meta?.telegram?.messageThreadId;
  const messageThreadId = outboundMessage.conversationRef.topicId
    ? Number(outboundMessage.conversationRef.topicId)
    : fallbackThreadId;
  let firstResult = null;

  if (outboundMessage.text) {
    const parts = splitText(outboundMessage.text);
    for (const part of parts) {
      const result = await api.sendMessage({
        chatId,
        messageThreadId,
        text: part,
        replyTo: firstResult ? undefined : outboundMessage.replyTo,
        meta: outboundMessage.meta
      });
      firstResult ??= result;
    }
  }

  for (const attachment of outboundMessage.attachments ?? []) {
    const isImage = attachment.disposition === 'image' || attachment.kind === 'image';
    const sendAttachment = isImage
      ? api.sendPhoto?.bind(api)
      : api.sendDocument?.bind(api);
    if (!sendAttachment) {
      throw new Error(`Telegram API client is missing ${isImage ? 'sendPhoto' : 'sendDocument'}`);
    }
    const result = await sendAttachment({
      chatId,
      messageThreadId,
      filePath: attachment.localPath,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      replyTo: firstResult ? undefined : outboundMessage.replyTo,
      meta: buildTelegramAttachmentMeta(outboundMessage.meta)
    });
    firstResult ??= result;
  }
  return firstResult;
}
