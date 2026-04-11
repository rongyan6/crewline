import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldHandleFeishuInbound } from '../../src/channel/feishu/feishu-policy.js';

function buildState(config = {}) {
  return {
    botOpenId: 'ou_bot',
    config
  };
}

function buildGroupMessage({
  chatId = 'oc_group',
  senderOpenId = 'ou_user',
  mentions = []
} = {}) {
  return {
    message: {
      chat_id: chatId,
      chat_type: 'group',
      mentions
    },
    senderOpenId
  };
}

function allow(params) {
  return shouldHandleFeishuInbound({
    message: params.message,
    senderOpenId: params.senderOpenId,
    accountState: params.accountState,
    text: params.text
  });
}

test('default policy enforces configured groupAllowFrom and mention rules', () => {
  const accountState = buildState({
    requireMention: true,
    groupAllowFrom: ['ou_owner']
  });

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_owner',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]
    }),
    accountState
  }).allowed, true);

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_user',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]
    }),
    accountState
  }).allowed, false);

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_owner',
      mentions: []
    }),
    accountState
  }).allowed, false);
});

test('missing groupAllowFrom means group message is rejected', () => {
  const accountState = buildState({
    requireMention: false,
    groupAllowFrom: []
  });

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_owner',
      mentions: []
    }),
    accountState
  }).allowed, false);
});

test('/admin_reg bypasses group mention and allow-list checks for bootstrap', () => {
  const accountState = buildState({
    requireMention: true,
    groupAllowFrom: []
  });

  assert.deepEqual(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_bootstrap',
      mentions: []
    }),
    accountState,
    text: '/admin_reg'
  }), {
    allowed: true,
    reason: 'admin_reg_bootstrap'
  });
});

test('/admin_reg bootstrap fallback also matches raw Feishu content with zero-width prefix', () => {
  const accountState = buildState({
    requireMention: true,
    groupAllowFrom: []
  });

  assert.deepEqual(allow({
    message: {
      chat_id: 'oc_group',
      chat_type: 'group',
      mentions: [],
      content: JSON.stringify({ text: '\u200B/admin_reg' })
    },
    senderOpenId: 'ou_bootstrap',
    accountState,
    text: ''
  }), {
    allowed: true,
    reason: 'admin_reg_bootstrap'
  });
});

test('global requireMention=false still enforces global groupAllowFrom', () => {
  const accountState = buildState({
    requireMention: false,
    groupAllowFrom: ['ou_reviewer']
  });

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_reviewer',
      mentions: []
    }),
    accountState
  }).allowed, true);

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_user',
      mentions: []
    }),
    accountState
  }).allowed, false);
});

test('group override groupAllowFrom has higher priority than global', () => {
  const accountState = buildState({
    requireMention: false,
    groupAllowFrom: ['ou_global'],
    groups: {
      oc_group: {
        groupAllowFrom: ['ou_group']
      }
    }
  });

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_group',
      mentions: []
    }),
    accountState
  }).allowed, true);

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_global',
      mentions: []
    }),
    accountState
  }).allowed, false);
});

test('group override requireMention has higher priority than global', () => {
  const accountState = buildState({
    requireMention: false,
    groupAllowFrom: ['ou_user'],
    groups: {
      oc_group: {
        requireMention: true
      }
    }
  });

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_user',
      mentions: []
    }),
    accountState
  }).allowed, false);

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_user',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]
    }),
    accountState
  }).allowed, true);
});

test('wildcard group override applies when exact group config is missing', () => {
  const accountState = buildState({
    requireMention: false,
    groupAllowFrom: ['ou_global'],
    groups: {
      '*': {
        requireMention: true,
        groupAllowFrom: ['ou_wildcard']
      }
    }
  });

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_wildcard',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]
    }),
    accountState
  }).allowed, true);

  assert.equal(allow({
    ...buildGroupMessage({
      senderOpenId: 'ou_wildcard',
      mentions: []
    }),
    accountState
  }).allowed, false);
});
