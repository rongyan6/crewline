import { createInboundMessage } from '../host/inbound-message.js';
import { createOutboundMessage } from '../host/outbound-message.js';
import { buildTelegramInboundText, resolveTelegramInboundHandling } from './telegram-media.js';

function extractTelegramMessageBody(message) {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.caption === 'string') return message.caption;
  return '';
}

function parseTelegramMentions(message, botUsername) {
  const body = extractTelegramMessageBody(message);
  const entities = message?.entities ?? message?.caption_entities ?? [];
  const mentionedUsernames = [];
  let botMentioned = false;

  for (const entity of entities) {
    if (entity?.type === 'mention' && typeof entity.offset === 'number' && typeof entity.length === 'number') {
      const mentionText = body.slice(entity.offset, entity.offset + entity.length);
      mentionedUsernames.push(mentionText);
      if (botUsername && mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
        botMentioned = true;
      }
    }
    if (entity?.type === 'text_mention') {
      mentionedUsernames.push(`@${entity.user?.username ?? entity.user?.id ?? 'user'}`);
      if (botUsername && entity.user?.username?.toLowerCase?.() === botUsername.toLowerCase()) {
        botMentioned = true;
      }
    }
  }

  if (!botMentioned && botUsername && body.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) {
    botMentioned = true;
  }

  return {
    body,
    botMentioned,
    mentionedUsernames
  };
}

function resolveTelegramThreadId(message) {
  if (message?.message_thread_id) {
    return String(message.message_thread_id);
  }
  return undefined;
}

export async function telegramUpdateToInbound(update, { accountId = 'default', api, dataDir, botUsername } = {}) {
  const message = update.message ?? update.edited_message;
  if (!message || !message.chat || !message.from) {
    return [];
  }

  const mentionState = parseTelegramMentions(message, botUsername);
  const timestamp = new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const { attachment, localReplyText } = await resolveTelegramInboundHandling({
    api,
    dataDir,
    message,
    timestamp
  });
  const text = buildTelegramInboundText({ message, attachment });
  if (!text && !localReplyText) return [];

  let scope = 'dm';
  if (message.chat.type === 'group' || message.chat.type === 'supergroup') {
    scope = message.is_topic_message ? 'topic' : 'group';
  }
  const topicId = resolveTelegramThreadId(message);

  return [
    createInboundMessage({
      channel: 'telegram',
      accountId,
      conversationRef: {
        channel: 'telegram',
        accountId,
        conversationId: String(message.chat.id),
        participantId: String(message.from.id),
        topicId,
        scope
      },
      senderRef: {
        userId: String(message.from.id),
        displayName: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
        username: message.from.username
      },
      messageId: String(message.message_id),
      text: text || localReplyText,
      timestamp,
      rawMeta: {
        updateId: update.update_id,
        messageThreadId: topicId ? Number(topicId) : undefined,
        attachments: attachment ? [attachment] : [],
        localReplyText,
        botMentioned: mentionState.botMentioned,
        mentionedUsernames: mentionState.mentionedUsernames,
        chatIsForum: message.chat?.is_forum === true
      }
    })
  ];
}

export function outboundToTelegramSendRequest(outboundMessage) {
  return createOutboundMessage({
    ...outboundMessage,
    channel: 'telegram',
    meta: {
      parse_mode: outboundMessage.format === 'html' ? 'HTML' : undefined,
      ...outboundMessage.meta
    }
  });
}
