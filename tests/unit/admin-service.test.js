import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleAdminCommand } from '../../src/admin/admin-service.js';

function createInboundMessage(text, overrides = {}) {
  return {
    channel: 'telegram',
    accountId: '8641929320',
    conversationRef: {
      channel: 'telegram',
      accountId: '8641929320',
      conversationId: '123',
      participantId: '123',
      scope: 'dm'
    },
    senderRef: {
      userId: '123'
    },
    text,
    ...overrides
  };
}

function createConfig() {
  return {
    channel: {
      telegram: {
        adminUserIds: ['123']
      }
    }
  };
}

function createDeps(overrides = {}) {
  return {
    getServiceStatus: async () => ({
      running: true,
      pid: 4321,
      launchd: { loaded: true },
      serviceState: { status: 'running', runtimeHome: '/tmp/runtime' },
      command: { programArguments: ['node', 'main.js'] },
      paths: { runtimeHome: '/tmp/runtime' }
    }),
    buildHealthReport: async () => ({
      ok: true,
      checkedAt: '2026-04-10T12:00:00.000Z',
      runtime: { ok: true },
      channels: [{ channel: 'telegram', ok: true }, { channel: 'wechat', ok: true }],
      stateStore: { runtimeBindings: 2, conversationLogs: 3 }
    }),
    runDoctorCapture: async (scope) => `doctor:${scope ?? 'default'}`,
    loadResolvedRuntimeConfig: async () => ({
      userConfig: {
        agents: {
          instances: {
            codex_cc: { providerId: 'codex', cwd: '/tmp/codex' },
            claude_cc: { providerId: 'claude', cwd: '/tmp/claude' }
          },
          providers: {
            codex: { driver: 'acpx', agent: 'codex' },
            claude: { driver: 'acpx', agent: 'claude' }
          }
        }
      },
      config: {
        secrets: {
          telegramAccounts: {}
        }
      },
      configPath: '/tmp/crewline.json'
    }),
    scheduleServiceCommand: () => {},
    ...overrides
  };
}

test('/admin_help returns command list', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_help'),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /管理命令/);
  assert.match(result.text, /\/admin_status/);
});

test('/admin_status summarizes service status', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_status'),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /running=true/);
  assert.match(result.text, /pid=4321/);
  assert.match(result.text, /serviceState=running/);
});

test('/admin_health summarizes health report', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_health'),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /健康度：ok/);
  assert.match(result.text, /readiness=fail|readiness=ok/);
  assert.match(result.text, /serviceState=running|serviceState=unknown/);
});

test('/admin_doctor without scope runs default doctor capture', async () => {
  const seen = [];
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_doctor'),
    config: createConfig(),
    deps: createDeps({
      runDoctorCapture: async (scope) => {
        seen.push(scope);
        return 'doctor ok';
      }
    })
  });

  assert.equal(result.handled, true);
  assert.equal(result.text, 'doctor ok');
  assert.deepEqual(seen, [null]);
});

test('/admin_doctor telegram passes normalized scope', async () => {
  const seen = [];
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_doctor telegram'),
    config: createConfig(),
    deps: createDeps({
      runDoctorCapture: async (scope) => {
        seen.push(scope);
        return 'doctor telegram ok';
      }
    })
  });

  assert.equal(result.text, 'doctor telegram ok');
  assert.deepEqual(seen, ['telegram']);
});

test('/admin_agent_add requires camelCase options and rejects unsupported providerId', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_agent_add agentId=review providerId=openai cwd=/tmp/review'),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /仅支持 claude 或 codex/);
});

test('/admin_agent_add rejects non-absolute cwd', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_agent_add agentId=review providerId=codex cwd=tmp/review'),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /cwd 必须是绝对路径/);
});

test('/admin_agent_cwd rejects missing cwd path', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_agent_cwd agentId=codex_cc cwd=/tmp/does-not-exist-for-crewline'),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /cwd 不存在/);
});

test('/admin_stop returns post-send action and triggers stop service', async () => {
  let scheduled = null;
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_stop'),
    config: createConfig(),
    deps: createDeps({
      scheduleServiceCommand: (command) => {
        scheduled = command;
      }
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /将停止 Crewline/);
  await result.postSendAction?.();
  assert.equal(scheduled, 'stop');
});

test('/admin_restart returns post-send action and triggers restart service', async () => {
  let scheduled = null;
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_restart'),
    config: createConfig(),
    deps: createDeps({
      scheduleServiceCommand: (command) => {
        scheduled = command;
      }
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /将重启 Crewline/);
  await result.postSendAction?.();
  assert.equal(scheduled, 'restart');
});

test('/admin_agents lists configured instances', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_agents'),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /codex_cc providerId=codex cwd=\/tmp\/codex/);
  assert.match(result.text, /claude_cc providerId=claude cwd=\/tmp\/claude/);
});

test('/admin_user requires explicit userId parameter', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_user'),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /缺少参数/);
  assert.match(result.text, /userId=<userId>/);
});

test('/admin_user adds specified telegram admin user and triggers restart', async () => {
  let savedConfig = null;
  let scheduled = null;
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_user userId=456'),
    config: createConfig(),
    deps: createDeps({
      loadResolvedRuntimeConfig: async () => ({
        userConfig: {
          channel: {
            telegram: {
              adminUserIds: ['123']
            }
          },
          agents: {
            instances: {
              codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
            },
            providers: {
              codex: { driver: 'acpx', agent: 'codex' }
            }
          }
        },
        config: {
          secrets: {
            telegramAccounts: {}
          }
        },
        configPath: '/tmp/crewline.json'
      }),
      persistUserConfig: async (_path, value) => {
        savedConfig = value;
      },
      scheduleServiceCommand: (command) => {
        scheduled = command;
      }
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /已将用户 456 加入 telegram 的 adminUserIds/);
  assert.deepEqual(savedConfig.channel.telegram.adminUserIds, ['123', '456']);
  assert.deepEqual(savedConfig.channel.telegram.groupAllowFrom, ['123', '456']);
  await result.postSendAction?.();
  assert.equal(scheduled, 'restart');
});

test('/admin_user adds specified feishu admin user', async () => {
  let savedConfig = null;
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_user userId=ou_admin_2', {
      channel: 'feishu',
      accountId: 'cli_app_id',
      conversationRef: {
        channel: 'feishu',
        accountId: 'cli_app_id',
        conversationId: 'oc_chat_1',
        participantId: 'ou_admin_1',
        scope: 'dm'
      },
      senderRef: { userId: 'ou_admin_1' }
    }),
    config: {
      channel: {
        feishu: {
          adminUserIds: ['ou_admin_1']
        }
      }
    },
    deps: createDeps({
      loadResolvedRuntimeConfig: async () => ({
        userConfig: {
          channel: {
            feishu: {
              adminUserIds: ['ou_admin_1']
            }
          },
          agents: {
            instances: {
              codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
            },
            providers: {
              codex: { driver: 'acpx', agent: 'codex' }
            }
          }
        },
        config: {
          secrets: {
            feishuAccounts: {
              cli_app_id: {
                appId: 'cli_app_id',
                appSecret: 'secret'
              }
            }
          }
        },
        configPath: '/tmp/crewline.json'
      }),
      persistUserConfig: async (_path, value) => {
        savedConfig = value;
      }
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /已将用户 ou_admin_2 加入 feishu 的 adminUserIds/);
  assert.deepEqual(savedConfig.channel.feishu.adminUserIds, ['ou_admin_1', 'ou_admin_2']);
  assert.deepEqual(savedConfig.channel.feishu.groupAllowFrom, ['ou_admin_1', 'ou_admin_2']);
});

test('/admin_user default restart launcher resolves crewline cli outside repo cwd', async () => {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewline-admin-cwd-'));
  let spawned = null;

  try {
    process.chdir(tempDir);
    const result = await handleAdminCommand({
      inboundMessage: createInboundMessage('/admin_user userId=456'),
      config: createConfig(),
      deps: createDeps({
        loadResolvedRuntimeConfig: async () => ({
          userConfig: {
            channel: {
              telegram: {
                adminUserIds: ['123']
              }
            },
            agents: {
              instances: {
                codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
              },
              providers: {
                codex: { driver: 'acpx', agent: 'codex' }
              }
            }
          },
          config: {
            secrets: {
              telegramAccounts: {}
            }
          },
          configPath: '/tmp/crewline.json'
        }),
        persistUserConfig: async () => {},
        scheduleServiceCommand: undefined,
        spawn: (command, args, options) => {
          spawned = { command, args, options };
          return { unref() {} };
        }
      })
    });

    await result.postSendAction?.();

    assert.equal(spawned.command, process.execPath);
    assert.match(spawned.args[0], /(?:^|\/)(bin|dist)\/crewline\.js$/);
    assert.ok(path.isAbsolute(spawned.args[0]));
    assert.equal(spawned.options.cwd, originalCwd);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('/admin_reg bootstraps telegram dm binding and adminUserIds when admin list is empty', async () => {
  let savedConfig = null;
  let scheduled = null;
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_reg'),
    config: {
      channel: {
        telegram: {
          adminUserIds: []
        }
      }
    },
    deps: createDeps({
      loadResolvedRuntimeConfig: async () => ({
        userConfig: {
          agents: {
            instances: {
              codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
            }
          },
          channel: {
            telegram: {
              accounts: {
                '8641929320': {
                  botToken: '8641929320:abc',
                  bindings: {
                    dm: {},
                    group: {},
                    topic: {}
                  }
                }
              }
            }
          }
        },
        config: {
          secrets: {
            telegramAccounts: {
              '8641929320': {
                botToken: '8641929320:abc'
              }
            }
          }
        },
        configPath: '/tmp/crewline.json'
      }),
      persistUserConfig: async (_path, value) => {
        savedConfig = value;
      },
      scheduleServiceCommand: (command) => {
        scheduled = command;
      }
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /当前私聊注册到 Agent codex_cc/);
  assert.equal(savedConfig.channel.telegram.accounts['8641929320'].bindings.dm['123'].instanceId, 'codex_cc');
  assert.deepEqual(savedConfig.channel.telegram.adminUserIds, ['123']);
  assert.deepEqual(savedConfig.channel.telegram.groupAllowFrom, ['123']);
  await result.postSendAction?.();
  assert.equal(scheduled, 'restart');
});

test('/admin_reg prompts for Telegram base config before bootstrap', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_reg'),
    config: {
      channel: {
        telegram: {
          adminUserIds: []
        }
      }
    },
    deps: createDeps({
      loadResolvedRuntimeConfig: async () => ({
        userConfig: {
          agents: {
            instances: {
              codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
            }
          },
          channel: {
            telegram: {
              accounts: {
                '8641929320': {
                  bindings: {
                    dm: {},
                    group: {},
                    topic: {}
                  }
                }
              }
            }
          }
        },
        config: {
          secrets: {
            telegramAccounts: {}
          }
        },
        configPath: '/tmp/crewline.json'
      })
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /Telegram 基础接入配置/);
  assert.match(result.text, /botToken/);
});

test('/admin_reg bootstraps Feishu dm binding and adminUserIds when app credentials exist', async () => {
  let savedConfig = null;
  let scheduled = null;
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_reg', {
      channel: 'feishu',
      accountId: 'cli_app_id',
      conversationRef: {
        channel: 'feishu',
        accountId: 'cli_app_id',
        conversationId: 'oc_chat_1',
        participantId: 'ou_admin_1',
        scope: 'dm'
      },
      senderRef: { userId: 'ou_admin_1' }
    }),
    config: {
      channel: {
        feishu: {
          adminUserIds: []
        }
      }
    },
    deps: createDeps({
      loadResolvedRuntimeConfig: async () => ({
        userConfig: {
          agents: {
            instances: {
              codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
            }
          },
          channel: {
            feishu: {
              accounts: {
                cli_app_id: {
                  appSecret: 'secret',
                  bindings: {
                    dm: {},
                    group: {}
                  }
                }
              }
            }
          }
        },
        config: {
          secrets: {
            feishuAccounts: {
              cli_app_id: {
                appId: 'cli_app_id',
                appSecret: 'secret'
              }
            }
          }
        },
        configPath: '/tmp/crewline.json'
      }),
      persistUserConfig: async (_path, value) => {
        savedConfig = value;
      },
      scheduleServiceCommand: (command) => {
        scheduled = command;
      }
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /当前私聊注册到 Agent codex_cc/);
  assert.equal(savedConfig.channel.feishu.accounts.cli_app_id.bindings.dm.ou_admin_1.instanceId, 'codex_cc');
  assert.deepEqual(savedConfig.channel.feishu.adminUserIds, ['ou_admin_1']);
  assert.deepEqual(savedConfig.channel.feishu.groupAllowFrom, ['ou_admin_1']);
  await result.postSendAction?.();
  assert.equal(scheduled, 'restart');
});

test('/admin_reg bootstraps Feishu group binding and scoped allow list when admin list is empty', async () => {
  let savedConfig = null;
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_reg', {
      channel: 'feishu',
      accountId: 'cli_app_id',
      messageId: 'om_group_reg_1',
      conversationRef: {
        channel: 'feishu',
        accountId: 'cli_app_id',
        conversationId: 'oc_group_1',
        participantId: 'ou_admin_1',
        scope: 'group'
      },
      senderRef: { userId: 'ou_admin_1' }
    }),
    config: {
      channel: {
        feishu: {
          adminUserIds: []
        }
      }
    },
    deps: createDeps({
      loadResolvedRuntimeConfig: async () => ({
        userConfig: {
          agents: {
            instances: {
              codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
            }
          },
          channel: {
            feishu: {
              accounts: {
                cli_app_id: {
                  appSecret: 'secret',
                  bindings: {
                    dm: {},
                    group: {}
                  }
                }
              }
            }
          }
        },
        config: {
          secrets: {
            feishuAccounts: {
              cli_app_id: {
                appId: 'cli_app_id',
                appSecret: 'secret'
              }
            }
          }
        },
        configPath: '/tmp/crewline.json'
      }),
      persistUserConfig: async (_path, value) => {
        savedConfig = value;
      }
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /当前群组注册到 Agent codex_cc/);
  assert.equal(savedConfig.channel.feishu.accounts.cli_app_id.bindings.group.oc_group_1.instanceId, 'codex_cc');
  assert.deepEqual(savedConfig.channel.feishu.accounts.cli_app_id.groups.oc_group_1.groupAllowFrom, ['ou_admin_1']);
  assert.deepEqual(savedConfig.channel.feishu.adminUserIds, ['ou_admin_1']);
});

test('duplicate admin command suppresses second reply when source message was already handled', async () => {
  const logReads = [];
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_help', {
      messageId: '12'
    }),
    config: createConfig(),
    live: {
      stateStore: {
        dataDir: '/tmp/runtime',
        conversationLog: {
          readAll: async (filePath) => {
            logReads.push(filePath);
            return [{
              role: 'system',
              meta: {
                reason: 'admin-command',
                command: '/admin_help',
                sourceMessageId: '12'
              }
            }];
          }
        }
      }
    },
    deps: createDeps()
  });

  assert.equal(logReads.length, 1);
  assert.equal(result.handled, true);
  assert.equal(result.suppressReply, true);
});

test('/admin_reg still requires admin access after bootstrap has configured adminUserIds', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_reg', {
      senderRef: { userId: '999' },
      conversationRef: {
        channel: 'telegram',
        accountId: '8641929320',
        conversationId: '999',
        participantId: '999',
        scope: 'dm'
      }
    }),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /没有管理权限/);
});

test('/admin_user still requires existing admin access', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_user userId=456', {
      senderRef: { userId: '999' },
      conversationRef: {
        channel: 'telegram',
        accountId: '8641929320',
        conversationId: '999',
        participantId: '999',
        scope: 'dm'
      }
    }),
    config: createConfig(),
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /没有管理权限/);
});

test('feishu unauthorized admin response includes app-scoped open_id details', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_help', {
      channel: 'feishu',
      accountId: 'cli_app_id',
      conversationRef: {
        channel: 'feishu',
        accountId: 'cli_app_id',
        conversationId: 'oc_chat_1',
        participantId: 'ou_admin_2',
        scope: 'dm'
      },
      senderRef: { userId: 'ou_admin_2' }
    }),
    config: {
      channel: {
        feishu: {
          adminUserIds: ['ou_admin_1']
        }
      }
    },
    deps: createDeps()
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /当前用户没有管理权限/);
  assert.match(result.text, /open_id=ou_admin_2/);
  assert.match(result.text, /chat_id=oc_chat_1/);
  assert.match(result.text, /account_id=cli_app_id/);
  assert.match(result.text, /command=\/admin_help/);
});

test('/admin_reg registers current telegram group and triggers restart', async () => {
  let scheduled = null;
  let savedConfig = null;
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_reg', {
      conversationRef: {
        channel: 'telegram',
        accountId: '8641929320',
        conversationId: '-100123',
        participantId: '123',
        scope: 'group'
      }
    }),
    config: createConfig(),
    deps: createDeps({
      loadResolvedRuntimeConfig: async () => ({
        userConfig: {
          agents: {
            instances: {
              codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
            }
          },
          channel: {
            telegram: {
              accounts: {
                '8641929320': {
                  bindings: {
                    dm: {
                      '123': { instanceId: 'codex_cc' }
                    },
                    group: {},
                    topic: {}
                  }
                }
              }
            }
          }
        },
        config: {
          secrets: {
            telegramAccounts: {
              '8641929320': {
                botToken: '8641929320:abc'
              }
            }
          }
        },
        configPath: '/tmp/crewline.json'
      }),
      persistUserConfig: async (_path, value) => {
        savedConfig = value;
      },
      scheduleServiceCommand: (command) => {
        scheduled = command;
      }
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /已将当前群组注册到 Agent codex_cc/);
  assert.equal(savedConfig.channel.telegram.accounts['8641929320'].bindings.group['-100123'].instanceId, 'codex_cc');
  await result.postSendAction?.();
  assert.equal(scheduled, 'restart');
});

test('/admin_reg treats Telegram forum General topic as group registration', async () => {
  let savedConfig = null;
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_reg', {
      conversationRef: {
        channel: 'telegram',
        accountId: '8641929320',
        conversationId: '-100123',
        participantId: '123',
        topicId: '1',
        scope: 'topic'
      },
      rawMeta: {
        chatIsForum: true,
        messageThreadId: 1
      }
    }),
    config: createConfig(),
    deps: createDeps({
      loadResolvedRuntimeConfig: async () => ({
        userConfig: {
          agents: {
            instances: {
              codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
            }
          },
          channel: {
            telegram: {
              accounts: {
                '8641929320': {
                  bindings: {
                    dm: {
                      '123': { instanceId: 'codex_cc' }
                    },
                    group: {},
                    topic: {}
                  }
                }
              }
            }
          }
        },
        config: {
          secrets: {
            telegramAccounts: {
              '8641929320': {
                botToken: '8641929320:abc'
              }
            }
          }
        },
        configPath: '/tmp/crewline.json'
      }),
      persistUserConfig: async (_path, value) => {
        savedConfig = value;
      }
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /已将当前群组注册到 Agent codex_cc/);
  assert.equal(savedConfig.channel.telegram.accounts['8641929320'].bindings.group['-100123'].instanceId, 'codex_cc');
  assert.equal(savedConfig.channel.telegram.accounts['8641929320'].bindings.topic?.['-100123:1'], undefined);
});

test('/admin_reg prompts for Feishu base config when app credentials are missing', async () => {
  const result = await handleAdminCommand({
    inboundMessage: createInboundMessage('/admin_reg', {
      channel: 'feishu',
      accountId: 'cli_app_id',
      conversationRef: {
        channel: 'feishu',
        accountId: 'cli_app_id',
        conversationId: 'oc_chat_1',
        participantId: 'ou_admin_1',
        scope: 'dm'
      },
      senderRef: { userId: 'ou_admin_1' }
    }),
    config: {
      channel: {
        feishu: {
          adminUserIds: []
        }
      }
    },
    deps: createDeps({
      loadResolvedRuntimeConfig: async () => ({
        userConfig: {
          agents: {
            instances: {
              codex_cc: { providerId: 'codex', cwd: '/tmp/codex' }
            }
          },
          channel: {
            feishu: {
              accounts: {
                cli_app_id: {
                  bindings: {
                    dm: {},
                    group: {}
                  }
                }
              }
            }
          }
        },
        config: {
          secrets: {
            feishuAccounts: {}
          }
        },
        configPath: '/tmp/crewline.json'
      })
    })
  });

  assert.equal(result.handled, true);
  assert.match(result.text, /飞书基础接入配置/);
  assert.match(result.text, /appSecret/);
});
