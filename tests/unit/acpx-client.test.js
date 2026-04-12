import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  findCrewlinePackageRoot,
  resolveBundledAcpxCommand,
  sanitizeSessionName
} from '../../src/runtime/acp/acpx-client.js';

test('sanitizeSessionName normalizes unsafe characters', () => {
  assert.equal(sanitizeSessionName('telegram:dm:1/2 3'), 'telegram:dm:1_2_3');
});

test('findCrewlinePackageRoot resolves the current package root', () => {
  assert.equal(findCrewlinePackageRoot(), process.cwd());
});

test('resolveBundledAcpxCommand points at crewline-installed acpx binary', () => {
  const expectedBasename = process.platform === 'win32' ? 'acpx.cmd' : 'acpx';
  const command = resolveBundledAcpxCommand();

  assert.equal(path.basename(command), expectedBasename);
  assert.equal(path.dirname(command), path.join(process.cwd(), 'node_modules', '.bin'));
});
