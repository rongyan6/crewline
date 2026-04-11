import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function buildInitialConfig({ projectDir, runtimeHome }) {
  return {
    runtime: {
      dataDir: runtimeHome
    },
    agents: {
      providers: {
        codex: {
          driver: 'acpx',
          agent: 'codex'
        }
      },
      instances: {
        codex_cc: {
          providerId: 'codex',
          cwd: projectDir
        }
      }
    },
    channel: {
      telegram: {
        adminUserIds: [],
        groupAllowFrom: [],
        streaming: true,
        accounts: {}
      },
      feishu: {
        enabled: false,
        adminUserIds: [],
        requireMention: true,
        network: {
          useSystemProxy: false
        },
        groupAllowFrom: [],
        accounts: {
          your_feishu_app_id: {
            appSecret: '',
            groups: {},
            bindings: {
              dm: {},
              group: {}
            }
          }
        }
      },
      wechat: {
        enabled: false,
        adminUserIds: [],
        bindings: {
          dm: {}
        }
      }
    }
  };
}

export function buildInitialEnvTemplate() {
  return '';
}

export async function initializeCrewlineProject({ cwd = process.cwd(), runtimeHome = path.join(os.homedir(), '.crewline'), force = false } = {}) {
  const configPath = path.join(runtimeHome, 'crewline.json');

  await fs.mkdir(runtimeHome, { recursive: true });

  const files = [{
    path: configPath,
    content: `${JSON.stringify(buildInitialConfig({ projectDir: cwd, runtimeHome }), null, 2)}\n`
  }];

  const written = [];
  const skipped = [];

  for (const file of files) {
    try {
      await fs.writeFile(file.path, file.content, {
        encoding: 'utf8',
        flag: force ? 'w' : 'wx'
      });
      written.push(file.path);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        skipped.push(file.path);
        continue;
      }
      throw error;
    }
  }

  return {
    runtimeHome,
    configPath,
    written,
    skipped
  };
}
