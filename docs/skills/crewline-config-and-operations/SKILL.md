---
name: crewline-config-and-operations
description: Use this skill when configuring, operating, or troubleshooting Crewline. Covers agent instances, Telegram/Feishu/WeChat channel setup, admin commands, service lifecycle, startup failures, doctor/health/status checks, and config-doc alignment using the local Crewline source tree and docs.
---

# Crewline Config And Operations

Use this skill when the task is about getting Crewline configured correctly, changing channel settings, fixing startup or routing issues, or performing day-to-day service operations.

Source of truth:

- Repository: [rongyan6/crewline](https://github.com/rongyan6/crewline)
- If Crewline was installed from npm, use the packaged docs that ship with the install
- When docs and code disagree, trust the code and then update the docs

## What This Skill Covers

- Editing `~/.crewline/crewline.json`
- Understanding `agents.providers` and `agents.instances`
- Telegram, Feishu, and WeChat channel setup
- Remote admin command behavior and limits
- Startup / restart / doctor / health / status troubleshooting
- Config validation failures, especially invalid `cwd`, missing bindings, and channel-specific gating
- Release-readiness checks for Crewline operations changes

## First Checks

When asked to diagnose or configure Crewline, inspect these in order:

1. `~/.crewline/crewline.json`
2. `~/.crewline/system.json` if present
3. `crewline status`
4. `crewline doctor`
5. Channel-specific doctor:
   - `crewline doctor telegram`
   - `crewline doctor feishu`
   - `crewline doctor wechat`
6. `~/.crewline/logs/`

## Current Config Model

Primary config file:

- `~/.crewline/crewline.json`

Runtime data:

- `~/.crewline/logs/`
- `~/.crewline/bindings/`
- `~/.crewline/conversations/`

Important current rule:

- `.env` is deprecated/removed from the user-facing config path
- Channel credentials now live directly in `crewline.json`

## Agent Instances

User bindings always target an agent instance, not a provider directly.

Relevant config shape:

```json
{
  "agents": {
    "providers": {
      "codex": { "driver": "acpx", "agent": "codex" },
      "claude": { "driver": "acpx", "agent": "claude" }
    },
    "instances": {
      "codex_cc": { "providerId": "codex", "cwd": "/absolute/path" },
      "claude_cc": { "providerId": "claude", "cwd": "/absolute/path" }
    }
  }
}
```

Operational rules:

- `providerId` must exist under `agents.providers`
- `cwd` should be an existing absolute path
- Remote admin commands currently only allow `providerId=codex|claude`

## Channel Highlights

### Telegram

Read the Telegram guide from the installed `docs/guide/channels/telegram.md`, or from the GitHub repo.

Key facts:

- Recommended multi-account model: `channel.telegram.accounts.<botId>`
- `accounts.<botId>.botToken` is required
- The account key must match the numeric prefix before the token colon
- `groupAllowFrom` controls who may trigger group/topic messages
- `requireMention.group` and `requireMention.topic` default to `false`
- `bindings` are split into `dm`, `group`, and `topic`
- Topic keys use `<chatId>:<topicId>`

### Feishu

Read the Feishu guide from the installed `docs/guide/channels/feishu.md`, or from the GitHub repo.

Key facts:

- Recommended multi-account model: `channel.feishu.accounts.<appId>`
- `accounts.<appId>.appSecret` is required
- `groupAllowFrom` is globally required for safety
- `network.useSystemProxy` defaults to `false`
- `requireMention` defaults to `true`
- No implicit owner fallback for group delivery

### WeChat

Read the WeChat guide from the installed `docs/guide/channels/wechat.md`, or from the GitHub repo.

Key facts:

- Current support is DM-only
- First-time login is `crewline wechat login`
- Bindings live under `bindings.dm`
- Login state is stored under `~/.crewline/channels/wechat/`

## Remote Admin Commands

Current admin commands:

- `/admin_help`
- `/admin_status`
- `/admin_health`
- `/admin_doctor [telegram|feishu|wechat]`
- `/admin_stop`
- `/admin_restart`
- `/admin_agents`
- `/admin_agent_add agentId=<agentId> providerId=<claude|codex> cwd=<cwd>`
- `/admin_agent_cwd agentId=<agentId> cwd=<cwd>`
- `/admin_reg`

Important command rules:

- Most admin commands are DM-only
- `/admin_reg` is the exception
  - Telegram: allowed in groups and topics
  - Feishu: allowed in groups
  - WeChat: not supported
- `agentId` means an entry under `agents.instances`
- `cwd` must be an existing absolute path

## Troubleshooting Workflow

Use this order:

1. Validate the target `cwd`
2. Validate the instance/provider relationship
3. Validate channel credential placement inside `crewline.json`
4. Validate bindings exist for the intended conversation type
5. Run `crewline doctor`
6. Run channel-specific doctor
7. Read the latest log file under `~/.crewline/logs/`
8. If the problem is a stale service process, restart the service and re-check status

## Common Failure Patterns

- Service fails to start because an instance `cwd` does not exist
- Telegram account key does not match bot token prefix
- Feishu group handling fails because global `groupAllowFrom` is empty
- WeChat appears configured but no QR login has been completed
- Admin command writes config but restart does not take effect because the service was stopped in-process instead of restarted externally

## Commands To Use

```bash
crewline help
crewline doctor
crewline doctor telegram
crewline doctor feishu
crewline doctor wechat
crewline start
crewline stop
crewline restart
crewline status
crewline health
crewline wechat login
```

## Editing Guidance

- Prefer small, reversible config changes
- Use code as the source of truth
- If behavior changes, update the relevant guide under `docs/guide/channels/`
- For user-facing operational fixes, also check the root README files:
  - `README.md`
  - `README.zh-CN.md`

## Release Checklist

Before claiming Crewline config/ops work is done:

1. `npm test`
2. `npm run build`
3. `crewline doctor`
4. `crewline status`
5. Confirm docs match the implementation
