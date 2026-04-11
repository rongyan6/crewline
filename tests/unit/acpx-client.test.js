import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSessionName } from '../../src/runtime/acp/acpx-client.js';

test('sanitizeSessionName normalizes unsafe characters', () => {
  assert.equal(sanitizeSessionName('telegram:dm:1/2 3'), 'telegram:dm:1_2_3');
});
