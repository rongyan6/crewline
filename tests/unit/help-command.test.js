import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHelp } from '../../src/app/help-command.js';

test('formatHelp lists init help and channel doctor commands', () => {
  const help = formatHelp({
    defaultRuntimeHome: '/Users/tester/.crewline'
  });

  assert.match(help, /Create the default ~\/\.crewline initial config/);
  assert.match(help, /doctor telegram/);
  assert.match(help, /doctor feishu/);
  assert.match(help, /doctor wechat/);
  assert.match(help, /prod-start/);
  assert.match(help, /prod-status/);
  assert.match(help, /\/Users\/tester\/\.crewline/);
});
