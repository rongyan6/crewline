import fs from 'node:fs/promises';
import path from 'node:path';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const esbuildBin = path.join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');

const entryPoints = [
  'bin/crewline.js',
  'src/app/main.js',
  'src/app/doctor-telegram.js',
  'src/app/doctor-feishu.js',
  'src/app/doctor-wechat.js'
];

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

execFileSync(esbuildBin, [
  ...entryPoints,
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  '--packages=external',
  '--minify',
  '--legal-comments=none',
  '--outdir=dist',
  '--entry-names=[name]'
], {
  cwd: rootDir,
  stdio: 'inherit'
});

chmodSync(path.join(distDir, 'crewline.js'), 0o755);
