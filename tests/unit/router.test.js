import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../../src/core/agents/agent-registry.js';
import { ConversationRouter } from '../../src/core/router/conversation-router.js';
import { createInboundMessage } from '../../src/channel/host/inbound-message.js';

test('router returns route decision for bound telegram user', () => {
  const registry = new AgentRegistry({
    providers: { codex: { driver: 'acpx', agent: 'codex' } },
    instances: { codex_cc: { providerId: 'codex', cwd: '/tmp', model: 'gpt-5.5[medium]' } }
  });
  const router = new ConversationRouter({
    bindings: { telegram: { dm: { '123': { instanceId: 'codex_cc' } }, group: {}, topic: {} } },
    agentRegistry: registry
  });
  const inbound = createInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    conversationRef: { channel: 'telegram', conversationId: '456', participantId: '123', scope: 'dm' },
    senderRef: { userId: '123' },
    messageId: '1',
    text: 'hi',
    timestamp: new Date().toISOString()
  });
  const decision = router.route(inbound);
  assert.equal(decision.instanceId, 'codex_cc');
  assert.equal(decision.agentName, 'codex');
  assert.equal(decision.conversationKey, 'telegram:dm:456');
  assert.equal(decision.model, 'gpt-5.5[medium]');
});

test('router returns route decision for bound telegram user in account-scoped bindings', () => {
  const registry = new AgentRegistry({
    providers: { codex: { driver: 'acpx', agent: 'codex' } },
    instances: { codex_cc: { providerId: 'codex', cwd: '/tmp' } }
  });
  const router = new ConversationRouter({
    bindings: {
      telegram: {
        dm: {},
        group: {},
        topic: {},
        accounts: {
          '8641929320': {
            dm: { '123': { instanceId: 'codex_cc' } },
            group: {},
            topic: {}
          }
        }
      }
    },
    agentRegistry: registry
  });
  const inbound = createInboundMessage({
    channel: 'telegram',
    accountId: '8641929320',
    conversationRef: { channel: 'telegram', accountId: '8641929320', conversationId: '456', participantId: '123', scope: 'dm' },
    senderRef: { userId: '123' },
    messageId: '1',
    text: 'hi',
    timestamp: new Date().toISOString()
  });
  const decision = router.route(inbound);
  assert.equal(decision.instanceId, 'codex_cc');
  assert.equal(decision.conversationKey, 'telegram:8641929320:dm:456');
});

test('router returns route decision for bound feishu user', () => {
  const registry = new AgentRegistry({
    providers: { codex: { driver: 'acpx', agent: 'codex' } },
    instances: { codex_cc: { providerId: 'codex', cwd: '/tmp' } }
  });
  const router = new ConversationRouter({
    bindings: {
      telegram: { dm: {}, group: {}, topic: {} },
      feishu: { dm: { ou_123: { instanceId: 'codex_cc' } }, group: {} }
    },
    agentRegistry: registry
  });
  const inbound = createInboundMessage({
    channel: 'feishu',
    accountId: 'default',
    conversationRef: { channel: 'feishu', conversationId: 'oc_456', participantId: 'ou_123', scope: 'dm' },
    senderRef: { userId: 'ou_123' },
    messageId: '1',
    text: 'hi',
    timestamp: new Date().toISOString()
  });
  const decision = router.route(inbound);
  assert.equal(decision.instanceId, 'codex_cc');
  assert.equal(decision.agentName, 'codex');
  assert.equal(decision.conversationKey, 'feishu:dm:oc_456');
});

test('router returns route decision for bound wechat user', () => {
  const registry = new AgentRegistry({
    providers: { codex: { driver: 'acpx', agent: 'codex' } },
    instances: { codex_cc: { providerId: 'codex', cwd: '/tmp' } }
  });
  const router = new ConversationRouter({
    bindings: {
      telegram: { dm: {}, group: {}, topic: {} },
      feishu: { dm: {}, group: {} },
      wechat: { dm: {}, accounts: { 'bot@im.bot': { dm: { wxid_alice: { instanceId: 'codex_cc' } } } } }
    },
    agentRegistry: registry
  });
  const inbound = createInboundMessage({
    channel: 'wechat',
    accountId: 'bot@im.bot',
    conversationRef: { channel: 'wechat', accountId: 'bot@im.bot', conversationId: 'wxid_alice', participantId: 'wxid_alice', scope: 'dm' },
    senderRef: { userId: 'wxid_alice' },
    messageId: '1',
    text: 'hi',
    timestamp: new Date().toISOString()
  });
  const decision = router.route(inbound);
  assert.equal(decision.instanceId, 'codex_cc');
  assert.equal(decision.agentName, 'codex');
  assert.equal(decision.conversationKey, 'wechat:bot@im.bot:dm:wxid_alice');
});
