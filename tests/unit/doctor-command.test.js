import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDoctorScript } from '../../src/app/doctor-command.js';

test('resolveDoctorScript resolves supported channel doctor subcommands', () => {
  assert.match(resolveDoctorScript('telegram') ?? '', /doctor-telegram\.js$/);
  assert.match(resolveDoctorScript('feishu') ?? '', /doctor-feishu\.js$/);
  assert.match(resolveDoctorScript('wechat') ?? '', /doctor-wechat\.js$/);
});

test('resolveDoctorScript returns null for unsupported doctor subcommands', () => {
  assert.equal(resolveDoctorScript('unknown'), null);
  assert.equal(resolveDoctorScript(null), null);
});
