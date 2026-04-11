import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildInitialConfig,
  buildInitialEnvTemplate,
  initializeCrewlineProject
} from '../../src/app/init-command.js';

test('buildInitialConfig uses project-local runtime and cwd defaults', () => {
  const config = buildInitialConfig({
    projectDir: '/tmp/project-a',
    runtimeHome: '/tmp/project-a/crewline'
  });

  assert.equal(config.runtime.dataDir, '/tmp/project-a/crewline');
  assert.equal(config.agents.instances.codex_cc.cwd, '/tmp/project-a');
  assert.equal(typeof config.channel.feishu.accounts, 'object');
  assert.equal(config.channel.feishu.network.useSystemProxy, false);
  assert.deepEqual(config.channel.feishu.accounts.your_feishu_app_id.groups, {});
  assert.equal(config.channel.telegram.streaming, true);
  assert.deepEqual(config.channel.telegram.accounts, {});
  assert.deepEqual(config.channel.wechat.bindings.dm, {});
});

test('buildInitialEnvTemplate includes channel secret placeholders', () => {
  const template = buildInitialEnvTemplate();
  assert.equal(template, '');
});

test('initializeCrewlineProject creates project-local config files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-init-'));
  const runtimeHome = path.join(dir, '.crewline');
  const result = await initializeCrewlineProject({ cwd: dir, runtimeHome });

  assert.equal(result.runtimeHome, runtimeHome);
  assert.equal(result.written.length, 1);
  const savedConfig = JSON.parse(await fs.readFile(result.configPath, 'utf8'));
  assert.equal(savedConfig.runtime.dataDir, runtimeHome);
});

test('initializeCrewlineProject skips existing files unless force is used', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-init-skip-'));
  const runtimeHome = path.join(dir, '.crewline');
  await initializeCrewlineProject({ cwd: dir, runtimeHome });
  const result = await initializeCrewlineProject({ cwd: dir, runtimeHome });

  assert.equal(result.written.length, 0);
  assert.equal(result.skipped.length, 1);
});
