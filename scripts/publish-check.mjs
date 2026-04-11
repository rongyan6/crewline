import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, { captureJson = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: captureJson ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} ${args.join(' ')} failed`);
  }
  if (!captureJson) return null;
  const stdout = result.stdout?.trim();
  return stdout ? JSON.parse(stdout) : null;
}

export function isAuditTransportFailure(output = '') {
  const text = String(output ?? '').toLowerCase();
  return [
    'client network socket disconnected before secure tls connection was established',
    'audit endpoint returned an error',
    'request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed',
    'fetch failed',
    'eai_again',
    'econnreset',
    'etimedout'
  ].some((pattern) => text.includes(pattern));
}

export function summarizeAuditVulnerabilities(auditJson = {}) {
  const total = auditJson?.metadata?.vulnerabilities?.total;
  if (typeof total === 'number') return total;
  if (auditJson?.vulnerabilities && typeof auditJson.vulnerabilities === 'object') {
    return Object.keys(auditJson.vulnerabilities).length;
  }
  return 0;
}

function runAuditCheck() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = spawnSync(npmCommand, ['audit', '--omit=dev', '--json'], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    if (result.error) throw result.error;

    const stdout = result.stdout?.trim() ?? '';
    const stderr = result.stderr?.trim() ?? '';
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    const auditJson = stdout ? JSON.parse(stdout) : null;
    const vulnerabilityCount = summarizeAuditVulnerabilities(auditJson);

    if (vulnerabilityCount > 0) {
      return { ok: false, audited: true, vulnerabilityCount };
    }
    if (result.status === 0) {
      return { ok: true, audited: true, vulnerabilityCount: 0 };
    }
    if (isAuditTransportFailure(combined)) {
      if (attempt < 2) continue;
      return {
        ok: true,
        audited: false,
        vulnerabilityCount: 0,
        warning: combined
      };
    }

    throw new Error(stderr || stdout || 'npm audit failed');
  }

  return {
    ok: true,
    audited: false,
    vulnerabilityCount: 0,
    warning: 'npm audit skipped after transport retries'
  };
}

export async function main() {
  run(npmCommand, ['run', 'build']);
  run(npmCommand, ['test']);
  const audit = runAuditCheck();

  const packJson = run(npmCommand, ['pack', '--dry-run', '--json'], { captureJson: true });
  const pack = Array.isArray(packJson) ? packJson[0] : packJson;
  const filePaths = (pack?.files ?? []).map((entry) => entry.path);

  const blocked = filePaths.filter((filePath) =>
    filePath.startsWith('src/') ||
    filePath.startsWith('tests/') ||
    filePath.startsWith('.omx/') ||
    filePath.endsWith('.map') ||
    filePath === 'AGENT.md' ||
    filePath === 'AGENTS.md' ||
    filePath === '.DS_Store' ||
    filePath.startsWith('docs/architecture/') ||
    filePath.startsWith('docs/design/')
  );

  const required = [
    'dist/crewline.js',
    'dist/main.js',
    'dist/doctor-telegram.js',
    'dist/doctor-feishu.js',
    'dist/doctor-wechat.js',
    'README.md',
    'docs/guide/README.md',
    'docs/guide/channels/telegram.md',
    'docs/guide/channels/feishu.md',
    'docs/guide/channels/wechat.md'
  ];

  const missing = required.filter((filePath) => !filePaths.includes(filePath));

  if (blocked.length > 0 || missing.length > 0 || !audit.ok) {
    console.error(JSON.stringify({
      blocked,
      missing,
      audit,
      files: filePaths
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    packageName: pack?.name ?? null,
    version: pack?.version ?? null,
    fileCount: filePaths.length,
    packageSize: pack?.size ?? null,
    audit
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
