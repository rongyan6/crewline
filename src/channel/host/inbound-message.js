export function createInboundMessage(input) {
  return Object.freeze({
    channel: input.channel,
    accountId: input.accountId,
    conversationRef: input.conversationRef,
    senderRef: input.senderRef,
    messageId: input.messageId,
    text: input.text,
    timestamp: input.timestamp,
    rawMeta: input.rawMeta ?? {}
  });
}
