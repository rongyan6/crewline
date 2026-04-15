# Crewline

[中文](./README.zh-CN.md)

Crewline (pronounced "crew-line") is a lightweight gateway for human and local AI agent collaboration over standard IM tools. The name reflects its role as an access gateway for human-and-agent collaboration. It supports Telegram, Feishu, and WeChat: Telegram supports direct messages, group chats, and topics; Feishu supports direct messages and group chats; WeChat supports direct messages.

The project started from a simple idea: use mature tools like Claude Code, Codex CLI, Gemini CLI, Cursor CLI, GitHub Copilot CLI, and other ACP-compatible coding agents to collaborate with local multi-agent runtimes remotely through messaging apps. Through ACPX, Crewline currently aligns with 16 built-in agent adapters plus custom ACP servers. Those agents are not limited to coding tasks. Compared with heavier systems such as OpenClaw or Hermes Agent, Crewline focuses on being a lighter gateway service with simpler configuration and easier day-to-day operation.

> Platform note:
> Crewline is primarily recommended on macOS and Linux.
> Windows compatibility is improving, but Windows testing is still not as complete, so please use it with extra caution.

## Built-in Agent Support

Current built-in agent support includes `pi`, `openclaw`, `codex`, `claude`, `gemini`, `cursor`, `copilot`, `droid`, `iflow`, `kilocode`, `kimi`, `kiro`, `opencode`, `qoder`, `qwen`, and `trae`.

## 1. Install

- Node.js `>= 22`

```bash
npm install -g crewline
```

After installation, the `crewline` command is available globally.

Note:
Crewline installs the common ACPX adapters for Codex and Claude directly, but ACPX can still invoke `npx` internally when it needs to fetch other agent adapters on first use.

Most users will not need to do anything here. If npm reports cache permission errors such as `EACCES` or `EPERM`, first inspect the active cache directory:

```bash
npm config get cache
```

Only if that directory is owned by `root` or another user, fix it with:

```bash
sudo chown -R "$(id -un)":"$(id -gn)" "$(npm config get cache)"
```

This usually happens after an earlier `sudo npm ...` run or another root-owned process touched the npm cache.

## 2. Initialize

Create the default config under `~/.crewline`:

```bash
crewline init
```

Show all supported commands:

```bash
crewline help
```

`crewline init` creates:

- `~/.crewline/crewline.json`

## 3. Configure Crewline

Edit `~/.crewline/crewline.json` and make sure the agent instance points to the real working directory you want the agent to operate in:

```json
{
  "runtime": {
    "dataDir": "~/.crewline"
  },
  "agents": {
    "providers": {
      "codex": {
        "driver": "acpx",
        "agent": "codex"
      }
    },
    "instances": {
      "codex_cc": {
        "providerId": "codex",
        "cwd": "/absolute/path/to/your/project"
      }
    }
  },
  "channel": {
    "telegram": {
      "adminUserIds": [],
      "groupAllowFrom": [],
      "streaming": true,
      "accounts": {}
    },
    "feishu": {
      "enabled": false,
      "adminUserIds": [],
      "network": {
        "useSystemProxy": false
      },
      "requireMention": true,
      "groupAllowFrom": [],
      "accounts": {
        "your_feishu_app_id": {
          "appSecret": "",
          "groups": {},
          "bindings": {
            "dm": {},
            "group": {}
          }
        }
      }
    },
    "wechat": {
      "enabled": false,
      "adminUserIds": [],
      "bindings": {
        "dm": {}
      }
    }
  }
}
```

At this stage, the most important part is:

- set the correct `cwd` for your local agent instance
- keep each channel at its minimal skeleton until you decide which one to enable

## 4. Configure a Message Channel

Then add at least one message channel to `~/.crewline/crewline.json` and fill its required settings.

Pick the channel guide you need:

- [Telegram Configuration](./docs/guide/channels/telegram.md)
- [Feishu Configuration](./docs/guide/channels/feishu.md)
- [WeChat Configuration](./docs/guide/channels/wechat.md)

Examples:

```bash
# Telegram
# put botToken in channel.telegram.accounts.<botId>.botToken

# Feishu
# put accounts.<appId>.appSecret directly into channel.feishu.accounts
# AppId is normally the key under accounts
# Feishu defaults to not using system proxy; set useSystemProxy=true only if you want that

# WeChat
# run first-time QR login after enabling channel.wechat
crewline wechat login
```

## 5. Validate and Start

Validate the config first:

```bash
crewline doctor
```

If the base config is valid, you can run the service:

```bash
crewline start
crewline status
crewline health
```

On macOS, `crewline start` uses `launchd` as the production service manager. If the launch agent is not installed yet, Crewline installs it automatically before starting.

If `crewline doctor` reports missing items, fix `~/.crewline/crewline.json` and run it again.

## 6. Manage the Service

Stop or restart the gateway:

```bash
crewline stop
crewline restart
```

`crewline stop` and `crewline restart` also clean up leftover Crewline service processes on the local machine, so you do not keep stale runtimes around after a restart.

Use these commands when you want to pre-install, refresh, or remove the macOS `launchd` agent explicitly:

```bash
crewline install
crewline uninstall
```

Local development entrypoints such as `npm run dev` still use direct foreground execution. The formal `crewline` service commands are meant to keep production-style service management on a single `launchd` path.

Run channel-specific checks when debugging a connection:

```bash
crewline doctor telegram
crewline doctor feishu
crewline doctor wechat
```

Send a proactive outbound message from scripts or external callers without starting a conversation:

```bash
crewline push telegram --list
crewline push telegram --chat-id -1001234567890 --text "deploy finished"
crewline push telegram --chat-id -1001234567890 --topic-id 42 --stdin
crewline push feishu --account your_app_id --chat-id oc_xxx --text "build passed"
crewline push wechat --account bot@im.bot --user-id wxid_xxx --text "agent finished"
```

Notes:

- `telegram` requires `--chat-id`, and supports `--topic-id` for forum topics
- `feishu` requires `--chat-id`
- `wechat` requires both `--account` and `--user-id`
- `--list` shows known targets grouped by `dm`, `group`, and `topic`
- message content can come from `--text` or `--stdin`

## 7. Remote Admin Commands

Crewline also supports a small set of remote admin commands over IM.

Current commands:

- `/admin_help`: show the admin command list
- `/admin_status`: show current service status
- `/admin_health`: show a lightweight health summary
- `/admin_doctor [telegram|feishu|wechat]`: run config or channel diagnostics
- `/admin_stop`: stop the Crewline service
- `/admin_restart`: restart the Crewline service
- `/admin_agents`: list configured agent instances
- `/admin_agent_add agentId=<agentId> providerId=<claude|codex> cwd=<cwd>`: add a new agent instance
- `/admin_agent_cwd agentId=<agentId> cwd=<cwd>`: update the working directory of an existing agent instance
- `/admin_reg`: register the current Telegram DM/group/topic or Feishu DM/group conversation on first use

How access works:

- configure channel-specific `adminUserIds` in `~/.crewline/crewline.json`
- most admin commands are DM-only
- `/admin_reg` is the exception used to register the current Telegram DM/group/topic or Feishu DM/group conversation
- WeChat supports the DM-only admin commands, but does not support `/admin_reg`

Important behavior notes:

- `/admin_agent_add` and `/admin_agent_cwd` require `cwd` to be an existing absolute path
- `/admin_agent_add` fails if `agentId` already exists
- `/admin_agent_cwd` fails if `agentId` does not exist
- `/admin_reg` is intended for first-time Telegram DM/group/topic or Feishu DM/group registration
- if the current channel has no `adminUserIds` yet, `/admin_reg` bootstraps the sender ID into `adminUserIds` and writes the current conversation binding
- `/admin_reg` still requires the base channel credentials to be configured first, for example `channel.telegram.accounts.<botId>.botToken` or `channel.feishu.accounts.<appId>.appSecret`
- service-mutating commands such as `/admin_stop`, `/admin_restart`, `/admin_agent_add`, `/admin_agent_cwd`, and `/admin_reg` apply changes only after the command reply is sent

## 8. Files You Will Use in Daily Operation

Once Crewline is running normally, the main user-facing files are:

- `~/.crewline/crewline.json`: your main config
- `~/.crewline/logs/`: runtime logs

You may also see runtime data such as bindings and conversation history under `~/.crewline/`. Those are normal runtime files and usually do not need manual edits.

## Typical First Run

```bash
crewline init
crewline help
# edit ~/.crewline/crewline.json
crewline doctor
crewline start
crewline status
```

On macOS, the expected steady state after first start is `mode: "launchd"` in `crewline status`.

## Notes

- Detailed architecture and design docs stay under [`docs/`](./docs/README.md).

## Using The Crewline Ops Skill In Your Own Agent

This repository also ships a reusable skill for configuration, operations, and troubleshooting:

- [`docs/skills/crewline-config-and-operations/SKILL.md`](./docs/skills/crewline-config-and-operations/SKILL.md)

If your own Agent supports installable or local skills, point it at that file and use it when you want help with:

- configuring `crewline.json`
- setting up Telegram / Feishu / WeChat channels
- running doctor / status / health checks
- understanding admin command behavior
- troubleshooting startup, binding, routing, and service issues

In practice, this works best when your Agent has:

1. access to your local Crewline config
2. access to the installed Crewline docs or this GitHub repository
3. permission to run operational commands such as `crewline doctor`, `crewline status`, and `crewline restart`

## Follow On WeChat

Follow our WeChat official account for updates:

![Crewline WeChat Official Account](./docs/images/wechat-qrcode.jpg)
