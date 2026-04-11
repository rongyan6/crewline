/**
 * A channel plugin must expose:
 * - id
 * - start()
 * - stop()
 * - toInbound(rawEvent)
 * - send(outboundMessage)
 * - healthcheck()
 */
export const CHANNEL_INTERFACE_VERSION = 1;
