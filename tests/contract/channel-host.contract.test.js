import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelPluginHost } from '../../src/channel/host/channel-plugin-host.js';

class FakePlugin {
  constructor() {
    this.id = 'telegram';
  }
  async start() {}
  async stop() {}
  async toInbound(rawEvent) {
    return [{ channel: 'telegram', payload: rawEvent }];
  }
  async send(message) {
    return { ok: true, message };
  }
}

test('channel host routes receive/send through registered plugin', async () => {
  const host = new ChannelPluginHost();
  host.register(new FakePlugin());
  const inbound = await host.receive('telegram', { hello: 'world' });
  const outbound = await host.send({ channel: 'telegram', text: 'ok' });
  assert.equal(inbound[0].channel, 'telegram');
  assert.equal(outbound.ok, true);
});
