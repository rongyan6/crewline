# Telegram Configuration

[中文](./telegram.zh-CN.md)

## 1. Prepare The Telegram Bot First

Crewline can only connect to a Telegram bot that already exists. Creating the bot, getting its token, finding its bot ID, and disabling privacy mode are prerequisite steps you must complete in Telegram / @BotFather yourself.

### 1.1 Create The Bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Follow the prompts to set:
   - the bot display name
   - the bot username
4. @BotFather will return a bot token once creation is complete.

Official references:

- [Telegram Bots: Introduction](https://core.telegram.org/bots)
- [From BotFather to “Hello World”](https://core.telegram.org/bots/tutorial)

### 1.2 Get The Token

- the bot token is the secret string returned by @BotFather
- it usually looks like:
  `1234567890:AA...`
- treat it like a password and do not leak it

### 1.3 Get The Bot ID

In Crewline's multi-account Telegram config, the key under `channel.telegram.accounts` should normally be the bot's numeric ID.

You can get it in two ways:

1. take the numeric prefix before the colon in the token
   for example:
   `1234567890:AA...`
   the bot ID is `1234567890`
2. call Telegram Bot API `getMe`
   official Bot API reference:
   [getMe / Bot API](https://core.telegram.org/bots/api)

Current Crewline behavior requires:

- the `accounts.<botId>` key
- to match the numeric token prefix

### 1.4 If You Want Group Replies Without @mentions, Disable Privacy Mode

Telegram's official FAQ explains:

- with privacy mode enabled, bots in groups only receive messages relevant to them
- with privacy mode disabled, bots receive ordinary group messages too, except messages sent by other bots

Reference:
- [Bots FAQ](https://core.telegram.org/bots/faq)

The usual way to disable privacy mode is through [@BotFather](https://t.me/BotFather):

- via `/setprivacy`
- or via Bot Settings > Group Privacy

If you want the bot to reply in groups or topics without being mentioned, you usually need both:

1. privacy mode disabled in @BotFather
2. `requireMention.group=false` or `requireMention.topic=false` in Crewline config

## 2. Where The Config Lives And How To Write It

Crewline's main config file is normally:

- `~/.crewline/crewline.json`

Recommended structure:

- `channel.telegram`: global defaults
- `channel.telegram.accounts`: multi-account map keyed by bot ID

Even if you only use one Telegram bot, it is still best to configure it under `accounts.<botId>`.

### 2.1 Minimal Working Example

Prerequisite: you already have `agents.instances` configured in `~/.crewline/crewline.json`, because the `instanceId` used in Telegram bindings comes from there.

This is enough to get started:

```json
{
  "channel": {
    "telegram": {
      "groupAllowFrom": ["8657006361"],
      "accounts": {
        "1234567890": {
          "botToken": "1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "bindings": {
            "dm": {
              "8657006361": {
                "instanceId": "codex_cc"
              }
            },
            "group": {},
            "topic": {}
          }
        }
      }
    }
  }
}
```

In that minimal example, the fields users most often need explained are:

- `1234567890`
  This is the Telegram bot ID, and also the key under `accounts`. In current Crewline behavior, it must match the numeric prefix before the colon in the bot token.
- `1234567890:AAxxxxxxxx...`
  This is the Telegram bot token returned by @BotFather.
- `8657006361`
  This is a Telegram user ID. It is commonly used for:
  - `groupAllowFrom`: who is allowed to trigger group / topic messages
  - `bindings.dm`: which private user should be bound to which Agent
- `instanceId`
  This is the key of an entry under `agents.instances` in `~/.crewline/crewline.json`, for example `codex_cc` or `claude_cc`

For example, if your config contains:

```json
"agents": {
  "instances": {
    "codex_cc": {
      "providerId": "codex",
      "cwd": "/Users/you/code/project-a"
    },
    "claude_cc": {
      "providerId": "claude",
      "cwd": "/Users/you/code/project-b"
    }
  }
}
```

then the valid `instanceId` values you can reference from Telegram bindings are:

- `codex_cc`
- `claude_cc`

If you want to configure a group binding, the shape is:

```json
"group": {
  "-1001234567890": {
    "instanceId": "claude_cc"
  }
}
```

If you want to configure a topic binding, the shape is:

```json
"topic": {
  "-1001234567890:42": {
    "instanceId": "codex_cc"
  }
}
```

In short, the values come from:

- bot token
  from @BotFather
- bot ID
  from the numeric prefix in the token, or from `getMe`
- user ID / group ID / topic ID
  from inbound logs after the bot receives a message
- `instanceId`
  from the keys under `agents.instances` in `~/.crewline/crewline.json`

### 2.2 Multi-Account Example

If you need multiple bots, expand it like this:

```json
{
  "channel": {
    "telegram": {
      "groupAllowFrom": ["8657006361"],
      "requireMention": {
        "group": false,
        "topic": false
      },
      "streaming": true,
      "accounts": {
        "1234567890": {
          "botToken": "1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "streaming": true,
          "bindings": {
            "dm": {
              "8657006361": {
                "instanceId": "codex_cc"
              }
            },
            "group": {
              "-1001234567890": {
                "instanceId": "claude_cc"
              }
            },
            "topic": {
              "-1001234567890:42": {
                "instanceId": "codex_cc"
              }
            }
          },
          "groups": {
            "-1001234567890": {
              "requireMention": false
            }
          },
          "topics": {
            "-1001234567890:42": {
              "requireMention": false
            }
          }
        }
      }
    }
  }
}
```

### 2.3 How To Get User ID / Group ID / Topic ID Before Binding

The usual approach is:

1. let the bot receive one real message
   - DM: have the user message the bot
   - group: send one message in the group
   - topic: send one message in the target topic
2. inspect inbound logs under `~/.crewline/`

You will normally find:

- user ID: the sender's Telegram ID
- group ID: the `chat.id`
- topic ID: the `message_thread_id`

### 2.4 How To Enable Admin Commands

If you want to run admin commands over Telegram, configure `adminUserIds` for that channel, for example:

```json
{
  "channel": {
    "telegram": {
      "adminUserIds": ["8657006361"]
    }
  }
}
```

Telegram currently supports:

- `/admin_help`
- `/admin_status`
- `/admin_health`
- `/admin_doctor telegram`
- `/admin_stop`
- `/admin_restart`
- `/admin_agents`
- `/admin_user userId=<userId>`
- `/admin_agent_add agentId=<agentId> providerId=<claude|codex> cwd=<cwd>`
- `/admin_agent_cwd agentId=<agentId> cwd=<cwd>`
- `/admin_reg`

Scope rules:

- most admin commands are DM-only
- `/admin_reg` is the exception; it can be used in Telegram DMs, groups, or topics to register the current conversation
- `/admin_user` is DM-only
- when `adminUserIds` is still empty, `/admin_reg` bootstraps the sender Telegram user ID and the current DM/group/topic binding together

Built-in conversation commands in bound Telegram conversations:

- `/reset`: recreate the current Agent runtime session without clearing conversation history or changing the binding
- more Crewline built-in conversation commands will be added later
- `/new` is not handled by Crewline; it is forwarded to the underlying Agent runtime if the provider supports it

## 3. Defaults, Required Fields, And Optional Features

### 3.1 Merge Rules

- `channel.telegram` is the global default layer
- `channel.telegram.accounts.<botId>` is the account layer
- when the same field exists in both places, the account layer overrides the global layer
- bindings normally live under `accounts.<botId>.bindings.dm/group/topic`
- `groups.<chatId>` only affects that group
- `topics.<chatId>:<topicId>` only affects that topic

In practice:

- put shared policy in the global layer
  for example `groupAllowFrom`, `requireMention`, `streaming`, `network.proxy`
- put tokens and bindings in the account layer
  for example `botToken`, `bindings`
- put one-off exceptions in the group / topic layer
  for example `groups.<chatId>.requireMention`

### 3.2 Required Fields

- `channel.telegram.accounts.<botId>.botToken`
- at least one `bindings.dm`, `bindings.group`, or `bindings.topic`
- if you use groups or topics, you should explicitly configure `channel.telegram.groupAllowFrom`

### 3.3 Key Fields

- `adminUserIds`: Telegram user IDs allowed to run admin commands
- `groupAllowFrom`: sender allowlist for groups and topics
- `requireMention.group`: whether group messages must @ the bot
- `requireMention.topic`: whether topic messages must @ the bot
- `streaming`: whether partial replies are streamed through Telegram message edits
- `network.proxy`: HTTP proxy for Telegram API access
- `accounts`: multi-account map keyed by bot ID
- `accounts.<botId>.botToken`: bot token for that account
- `accounts.<botId>.bindings.dm`: DM bindings
- `accounts.<botId>.bindings.group`: group bindings
- `accounts.<botId>.bindings.topic`: topic bindings
- `groups.<chatId>.groupAllowFrom`: per-group allowlist override
- `topics.<chatId>:<topicId>.groupAllowFrom`: per-topic allowlist override

### 3.4 Defaults

- `adminUserIds`: defaults to `[]`
- `groupAllowFrom`: defaults to `[]`
- `requireMention.group`: defaults to `false`
- `requireMention.topic`: defaults to `false`
- `streaming`: defaults to `false`
- `network.proxy`: defaults to `null`
- `network.autoSelectFamily`: defaults to `true`
- `network.dangerouslyAllowPrivateNetwork`: defaults to `false`
- `polling.timeoutSeconds`: defaults to `30`
- `groups`: defaults to `{}`
- `topics`: defaults to `{}`

## 4. Pitfalls And Things To Watch

### 4.1 Group Replies Without @mentions Need More Than One Setting

If you want the bot to receive ordinary group or topic messages without requiring `@bot`, you usually need all of the following:

1. privacy mode disabled in @BotFather
2. `requireMention.group=false` or `requireMention.topic=false`
3. the sender included in `groupAllowFrom`

Changing only one of these is usually not enough.

### 4.2 The Mainline Runtime Uses Polling

- current mainline mode uses polling
- webhook fields still exist in config resolution, but webhook is not the primary operating path

### 4.3 Group And Topic Binding Keys Are Different

- group binding key = `chatId`
- topic binding key = `<chatId>:<topicId>`

If you write the wrong shape, Crewline will not hit the intended topic binding.

### 4.4 Bot ID Must Match The Token Prefix

Current Crewline validates that:

- the `accounts.<botId>` key
- must match the numeric prefix before the colon in `botToken`

If these do not match, config validation will fail.

## Doctor

```bash
crewline doctor telegram
```
