import { resolveOutboundAttachments } from './outbound-attachments.js';

export function createOutboundMessage(input) {
  return Object.freeze({
    channel: input.channel,
    accountId: input.accountId,
    conversationRef: input.conversationRef,
    text: input.text,
    attachments: resolveOutboundAttachments({
      attachments: input.attachments,
      meta: input.meta
    }),
    replyTo: input.replyTo,
    format: input.format ?? 'plain',
    meta: input.meta ?? {}
  });
}
