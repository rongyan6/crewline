import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResolvedFeishuAccounts } from '../../src/config/channel-config.js';
import { listResolvedFeishuAccounts } from '../../src/channel/feishu/feishu-accounts.js';

test('buildResolvedFeishuAccounts supports explicit multi-account model with shared defaults', () => {
  const accounts = buildResolvedFeishuAccounts({
    channel: {
      feishu: {
        enabled: true,
        requireMention: false,
        groupAllowFrom: ['ou_owner'],
        accounts: {
          'main-app-id': {
            appSecret: 'main-app-secret',
            groups: {
              oc_group: {
                requireMention: false
              }
            },
            bindings: { dm: { ou_main: { instanceId: 'codex_cc' } }, group: {} }
          },
          'review-app-id': {
            appSecret: 'review-app-secret',
            bindings: { dm: { ou_review: { instanceId: 'claude_cc' } }, group: {} }
          }
        }
      }
    }
  });

  assert.deepEqual(Object.keys(accounts), ['main-app-id', 'review-app-id']);
  assert.equal(accounts['main-app-id'].appId, 'main-app-id');
  assert.equal(accounts['main-app-id'].requireMention, false);
  assert.deepEqual(accounts['main-app-id'].groupAllowFrom, ['ou_owner']);
  assert.equal(accounts['main-app-id'].groups.oc_group.requireMention, false);
  assert.deepEqual(accounts['review-app-id'].bindings.dm, { ou_review: { instanceId: 'claude_cc' } });
});

test('listResolvedFeishuAccounts applies runtime defaults with system proxy disabled by default', () => {
  const [account] = listResolvedFeishuAccounts({
    channel: {
      feishu: {
        enabled: true,
        accounts: {
          'main-app-id': {
            appSecret: 'secret',
            bindings: { dm: {}, group: {} }
          }
        }
      }
    }
  }, {});

  assert.equal(account.config.network.useSystemProxy, false);
});
