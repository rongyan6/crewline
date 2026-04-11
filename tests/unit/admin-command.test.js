import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAdminHelp, parseAdminCommand, tokenizeCommand } from '../../src/admin/admin-command.js';

test('tokenizeCommand keeps quoted cwd segments together', () => {
  assert.deepEqual(
    tokenizeCommand('/admin_agent_add agentId=codexReview providerId=codex cwd="/tmp/with space"'),
    ['/admin_agent_add', 'agentId=codexReview', 'providerId=codex', 'cwd=/tmp/with space']
  );
});

test('parseAdminCommand parses positional and key value args', () => {
  const parsed = parseAdminCommand('/admin_agent_cwd agentId=codex_cc cwd="/tmp/project a"');
  assert.equal(parsed.name, 'agent_cwd');
  assert.deepEqual(parsed.args, []);
  assert.equal(parsed.options.agentid, 'codex_cc');
  assert.equal(parsed.options.cwd, '/tmp/project a');
});

test('formatAdminHelp enumerates admin commands', () => {
  assert.match(formatAdminHelp(), /\/admin_restart/);
  assert.match(formatAdminHelp(), /\/admin_user/);
  assert.match(formatAdminHelp(), /\/admin_reg/);
  assert.doesNotMatch(formatAdminHelp(), /\/admin_add/);
  assert.doesNotMatch(formatAdminHelp(), /\/admin_start/);
});
