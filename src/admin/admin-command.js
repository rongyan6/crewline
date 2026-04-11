const ADMIN_COMMANDS = new Map([
  ['/admin_restart', 'restart'],
  ['/admin_doctor', 'doctor'],
  ['/admin_stop', 'stop'],
  ['/admin_status', 'status'],
  ['/admin_health', 'health'],
  ['/admin_agents', 'agents'],
  ['/admin_user', 'user'],
  ['/admin_agent_add', 'agent_add'],
  ['/admin_agent_cwd', 'agent_cwd'],
  ['/admin_reg', 'reg'],
  ['/admin_help', 'help']
]);

function normalizeKey(value = '') {
  return String(value).trim().replace(/^-+/, '').toLowerCase();
}

export function tokenizeCommand(text = '') {
  const input = String(text ?? '').trim();
  if (!input) return [];
  const tokens = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseAdminCommand(text = '') {
  const tokens = tokenizeCommand(text);
  if (tokens.length === 0) return null;
  const rawCommand = String(tokens[0]).trim().toLowerCase();
  const name = ADMIN_COMMANDS.get(rawCommand);
  if (!name) return null;

  const args = [];
  const options = {};
  for (const token of tokens.slice(1)) {
    const separator = token.indexOf('=');
    if (separator === -1) {
      args.push(token);
      continue;
    }
    const key = normalizeKey(token.slice(0, separator));
    const value = token.slice(separator + 1);
    if (!key) {
      args.push(token);
      continue;
    }
    options[key] = value;
  }

  return {
    raw: rawCommand,
    name,
    args,
    options
  };
}

export function formatAdminHelp() {
  return [
    '管理命令：',
    '/admin_help 查看命令列表',
    '/admin_status 查看服务状态',
    '/admin_health 查看健康度',
    '/admin_doctor [telegram|feishu|wechat] 诊断配置/通道',
    '/admin_stop 停止服务',
    '/admin_restart 重启服务',
    '/admin_agents 查看 agent 实例',
    '/admin_user userId=<userId> 将指定用户加入当前通道的 adminUserIds',
    '/admin_agent_add agentId=<agentId> providerId=<claude|codex> cwd=<cwd>',
    '/admin_agent_cwd agentId=<agentId> cwd=<cwd>',
    '/admin_reg 在当前私聊/群组/Topic中注册当前会话绑定'
  ].join('\n');
}
