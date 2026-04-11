import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationKey, conversationLogPath, runtimeBindingPath } from '../../src/channel/host/conversation-ref.js';

test('conversation key uses channel scope and conversation id', () => {
  const key = buildConversationKey({ channel: 'telegram', scope: 'dm', conversationId: '123', participantId: 'u1' });
  assert.equal(key, 'telegram:dm:123');
});

test('conversation key and paths include non-default account ids', () => {
  assert.equal(
    buildConversationKey({ channel: 'telegram', accountId: '8641929320', scope: 'dm', conversationId: '123', participantId: 'u1' }),
    'telegram:8641929320:dm:123'
  );
  assert.equal(
    runtimeBindingPath({ dataDir: '/tmp/.crewline', conversationRef: { channel: 'telegram', accountId: '8641929320', scope: 'dm', conversationId: '123' } }),
    '/tmp/.crewline/bindings/telegram/8641929320/dm/123.json'
  );
  assert.equal(
    conversationLogPath({ dataDir: '/tmp/.crewline', conversationRef: { channel: 'telegram', accountId: '8641929320', scope: 'dm', conversationId: '123' } }),
    '/tmp/.crewline/conversations/telegram/8641929320/dm/123.jsonl'
  );
});

test('runtime binding and conversation log paths resolve dm and topic layout', () => {
  assert.equal(
    runtimeBindingPath({ dataDir: '/tmp/.crewline', conversationRef: { channel: 'telegram', scope: 'dm', conversationId: '123' } }),
    '/tmp/.crewline/bindings/telegram/dm/123.json'
  );
  assert.equal(
    runtimeBindingPath({ dataDir: '/tmp/.crewline', conversationRef: { channel: 'telegram', scope: 'topic', conversationId: '-1001', topicId: '42', participantId: '42' } }),
    '/tmp/.crewline/bindings/telegram/topic/-1001-42.json'
  );
  assert.equal(
    conversationLogPath({ dataDir: '/tmp/.crewline', conversationRef: { channel: 'telegram', scope: 'dm', conversationId: '123' } }),
    '/tmp/.crewline/conversations/telegram/dm/123.jsonl'
  );
});
