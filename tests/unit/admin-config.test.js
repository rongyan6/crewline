import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAdminUser,
  applyAgentAdd,
  applyAgentCwd,
  applyConversationRegistration,
  getExistingRegistration,
  getPreferredAgentIdForRegistration
} from '../../src/admin/admin-config.js';

test('applyAgentAdd creates a new agent instance', () => {
  const updated = applyAgentAdd({
    agents: {
      providers: {
        codex: { driver: 'acpx', agent: 'codex' }
      },
      instances: {}
    }
  }, {
    id: 'codex_review',
    providerId: 'codex',
    cwd: '/tmp/review'
  });

  assert.deepEqual(updated.agents.instances.codex_review, {
    providerId: 'codex',
    cwd: '/tmp/review'
  });
});

test('applyAgentCwd preserves instance metadata and updates cwd', () => {
  const updated = applyAgentCwd({
    agents: {
      instances: {
        codex_cc: {
          providerId: 'codex',
          cwd: '/tmp/a',
          approvalMode: 'default'
        }
      }
    }
  }, {
    id: 'codex_cc',
    cwd: '/tmp/b'
  });

  assert.deepEqual(updated.agents.instances.codex_cc, {
    providerId: 'codex',
    cwd: '/tmp/b',
    approvalMode: 'default'
  });
});

test('getPreferredAgentIdForRegistration prefers sender dm binding for telegram account', () => {
  const agentId = getPreferredAgentIdForRegistration({
    agents: {
      instances: {
        codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
      }
    },
    channel: {
      telegram: {
        accounts: {
          '8641929320': {
            bindings: {
              dm: {
                '123': { instanceId: 'codex_cc' }
              }
            }
          }
        }
      }
    }
  }, {
    channel: 'telegram',
    accountId: '8641929320',
    senderRef: { userId: '123' }
  });

  assert.equal(agentId, 'codex_cc');
});

test('applyAdminUser syncs telegram admin user into global groupAllowFrom', () => {
  const updated = applyAdminUser({
    channel: {
      telegram: {
        adminUserIds: ['123'],
        groupAllowFrom: ['123']
      }
    }
  }, {
    channelId: 'telegram',
    userId: '456'
  });

  assert.deepEqual(updated.channel.telegram.adminUserIds, ['123', '456']);
  assert.deepEqual(updated.channel.telegram.groupAllowFrom, ['123', '456']);
});

test('applyAdminUser syncs feishu admin user into global groupAllowFrom', () => {
  const updated = applyAdminUser({
    channel: {
      feishu: {
        adminUserIds: ['ou_123'],
        groupAllowFrom: ['ou_123']
      }
    }
  }, {
    channelId: 'feishu',
    userId: 'ou_456'
  });

  assert.deepEqual(updated.channel.feishu.adminUserIds, ['ou_123', 'ou_456']);
  assert.deepEqual(updated.channel.feishu.groupAllowFrom, ['ou_123', 'ou_456']);
});

test('applyConversationRegistration registers telegram topic and scoped allow list', () => {
  const updated = applyConversationRegistration({
    channel: {
      telegram: {
        accounts: {
          '8641929320': {
            bindings: { dm: {}, group: {}, topic: {} }
          }
        }
      }
    }
  }, {
    channel: 'telegram',
    accountId: '8641929320',
    senderRef: { userId: '123' },
    conversationRef: {
      scope: 'topic',
      conversationId: '-1001',
      topicId: '42'
    }
  }, 'codex_cc');

  assert.equal(updated.channel.telegram.accounts['8641929320'].bindings.topic['-1001:42'].instanceId, 'codex_cc');
  assert.deepEqual(updated.channel.telegram.topics['-1001:42'].groupAllowFrom, ['123']);
});

test('applyConversationRegistration bootstraps telegram dm binding and adminUserIds', () => {
  const updated = applyConversationRegistration({
    channel: {
      telegram: {
        accounts: {
          '8641929320': {
            bindings: { dm: {}, group: {}, topic: {} }
          }
        }
      }
    }
  }, {
    channel: 'telegram',
    accountId: '8641929320',
    senderRef: { userId: '123' },
    conversationRef: {
      scope: 'dm',
      conversationId: '123',
      participantId: '123'
    }
  }, 'codex_cc');

  assert.equal(updated.channel.telegram.accounts['8641929320'].bindings.dm['123'].instanceId, 'codex_cc');
  assert.deepEqual(updated.channel.telegram.adminUserIds, ['123']);
  assert.deepEqual(updated.channel.telegram.groupAllowFrom, ['123']);
});

test('applyConversationRegistration bootstraps feishu dm binding, adminUserIds and global groupAllowFrom', () => {
  const updated = applyConversationRegistration({
    channel: {
      feishu: {
        accounts: {
          default: {
            bindings: { dm: {}, group: {} }
          }
        }
      }
    }
  }, {
    channel: 'feishu',
    accountId: 'default',
    senderRef: { userId: 'ou_123' },
    conversationRef: {
      scope: 'dm',
      conversationId: 'oc_chat_1',
      participantId: 'ou_123'
    }
  }, 'codex_cc');

  assert.equal(updated.channel.feishu.accounts.default.bindings.dm.ou_123.instanceId, 'codex_cc');
  assert.deepEqual(updated.channel.feishu.adminUserIds, ['ou_123']);
  assert.deepEqual(updated.channel.feishu.groupAllowFrom, ['ou_123']);
});

test('getExistingRegistration returns current feishu group binding', () => {
  const existing = getExistingRegistration({
    channel: {
      feishu: {
        accounts: {
          default: {
            bindings: {
              group: {
                oc_123: { instanceId: 'claude_cc' }
              }
            }
          }
        }
      }
    }
  }, {
    channel: 'feishu',
    accountId: 'default',
    conversationRef: {
      scope: 'group',
      conversationId: 'oc_123'
    }
  });

  assert.deepEqual(existing, { instanceId: 'claude_cc' });
});

test('getExistingRegistration returns current feishu dm binding', () => {
  const existing = getExistingRegistration({
    channel: {
      feishu: {
        accounts: {
          default: {
            bindings: {
              dm: {
                ou_123: { instanceId: 'codex_cc' }
              },
              group: {}
            }
          }
        }
      }
    }
  }, {
    channel: 'feishu',
    accountId: 'default',
    conversationRef: {
      scope: 'dm',
      conversationId: 'oc_chat_1',
      participantId: 'ou_123'
    }
  });

  assert.deepEqual(existing, { instanceId: 'codex_cc' });
});
