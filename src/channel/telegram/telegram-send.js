const TELEGRAM_MAX_TEXT_LENGTH = 4096;

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
  const parts = splitText(outboundMessage.text);
  let firstResult = null;
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
  return firstResult;
}
