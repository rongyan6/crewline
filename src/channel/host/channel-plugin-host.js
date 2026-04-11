import { CrewlineError } from '../../shared/errors/error-envelope.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';

export class ChannelPluginHost {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.plugins = new Map();
    this.inboundHandler = null;
  }

  register(plugin) {
    this.plugins.set(plugin.id, plugin);
    return plugin;
  }

  get(channelId) {
    return this.plugins.get(channelId);
  }

  setInboundHandler(handler) {
    this.inboundHandler = handler;
  }

  async startAll() {
    for (const [channelId, plugin] of this.plugins.entries()) {
      await plugin.start?.({
        emitRawEvent: async (rawEvent) => this.dispatchRawEvent(channelId, rawEvent)
      });
    }
  }

  async stopAll() {
    for (const plugin of this.plugins.values()) {
      await plugin.stop?.();
    }
  }

  async receive(channelId, rawEvent) {
    const plugin = this.get(channelId);
    if (!plugin) {
      throw new CrewlineError({
        code: ErrorCodes.CHANNEL_UNAVAILABLE,
        layer: 'channel',
        recoverable: false,
        message: `Channel plugin not found: ${channelId}`
      });
    }
    return plugin.toInbound(rawEvent);
  }

  async dispatchRawEvent(channelId, rawEvent) {
    const inboundMessages = await this.receive(channelId, rawEvent);
    const results = [];
    if (!this.inboundHandler) return inboundMessages;
    for (const inboundMessage of inboundMessages) {
      results.push(await this.inboundHandler(inboundMessage));
    }
    return results;
  }

  async send(outboundMessage) {
    const plugin = this.get(outboundMessage.channel);
    if (!plugin) {
      throw new CrewlineError({
        code: ErrorCodes.CHANNEL_UNAVAILABLE,
        layer: 'channel',
        recoverable: false,
        message: `Channel plugin not found: ${outboundMessage.channel}`
      });
    }
    return plugin.send(outboundMessage);
  }
}
