# Feishu Configuration

[中文](./feishu.zh-CN.md)

## 1. Prepare The Feishu Bot First

Crewline can only connect to a Feishu app / bot that already exists. Creating the app, enabling the bot, subscribing to events, and requesting scopes must be done in the Feishu developer console first. AI cannot complete that setup for you.

### 1.1 Create The App And Bot

1. Open the Feishu developer console:
   [Create App](https://open.feishu.cn/app?lang=zh-CN)
2. After creating the app, add the “Bot” capability.
3. In the `Credentials & Basic Info` section, get:
   - `AppID`
   - `App Secret`
4. In `Events and Callbacks`:
   - choose `long connection` as the subscription mode
   - subscribe to event `im.message.receive_v1`

### 1.2 Request Permissions

If plugins or document-related features fail because of missing permissions, you can bulk import scopes in the developer console:

1. Go to `Permission Management`.
2. Click `Bulk Import/Export Permissions`.
3. In the `Import` tab, replace the sample JSON with the payload below, then continue and confirm the new scopes.

```json
{
  "scopes": {
    "tenant": [
      "contact:contact.base:readonly",
      "docx:document:readonly",
      "im:chat:read",
      "im:chat:update",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:recall",
      "im:message:send_as_bot",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource",
      "application:application:self_manage",
      "cardkit:card:write",
      "cardkit:card:read",
      "drive:drive.metadata:readonly",
      "docs:document.comment:create",
      "docs:document.comment:delete",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.comment:write_only",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "docx:document.block:convert"
    ],
    "user": [
      "contact:user.employee_id:readonly",
      "offline_access",
      "base:app:copy",
      "base:field:create",
      "base:field:delete",
      "base:field:read",
      "base:field:update",
      "base:record:create",
      "base:record:delete",
      "base:record:retrieve",
      "base:record:update",
      "base:table:create",
      "base:table:read",
      "base:table:update",
      "base:view:read",
      "base:view:write_only",
      "base:app:create",
      "base:app:update",
      "base:app:read",
      "sheets:spreadsheet.meta:read",
      "sheets:spreadsheet:read",
      "sheets:spreadsheet:create",
      "sheets:spreadsheet:write_only",
      "docs:document:export",
      "docs:document.media:upload",
      "board:whiteboard:node:create",
      "board:whiteboard:node:read",
      "calendar:calendar:read",
      "calendar:calendar.event:create",
      "calendar:calendar.event:read",
      "calendar:calendar.event:reply",
      "calendar:calendar.event:update",
      "calendar:calendar.free_busy:read",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "contact:user:search",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.media:download",
      "docs:document:copy",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive.metadata:readonly",
      "drive:file:download",
      "drive:file:upload",
      "im:chat.members:read",
      "im:chat:read",
      "im:message",
      "im:message.group_msg:get_as_user",
      "im:message.p2p_msg:get_as_user",
      "im:message:readonly",
      "search:docs:read",
      "search:message",
      "space:document:move",
      "space:document:retrieve",
      "task:comment:read",
      "task:comment:write",
      "task:task:read",
      "task:task:write",
      "task:task:writeonly",
      "task:tasklist:read",
      "task:tasklist:write",
      "wiki:node:copy",
      "wiki:node:create",
      "wiki:node:move",
      "wiki:node:read",
      "wiki:node:retrieve",
      "wiki:space:read",
      "wiki:space:retrieve",
      "wiki:space:write_only",
      "contact:user.basic_profile:readonly"
    ]
  }
}
```

4. Submit the permission request.
5. Keep the app-identity data scope at the default setting:
   `same as the app's available scope`
6. Confirm the change.

## 2. Where The Config Lives And How To Write It

Crewline's main config file is normally:

- `~/.crewline/crewline.json`

Recommended structure:

- `channel.feishu`: global defaults
- `channel.feishu.accounts`: multi-account map keyed by `appId`

The current implementation is centered around the multi-account object model. Even if you only run one Feishu bot, it is still best to configure it under `accounts.<appId>`.

### 2.1 Minimal Working Example

Prerequisite: you already have `agents.instances` configured in `~/.crewline/crewline.json`, because the `instanceId` used in Feishu bindings comes from there.

This is enough to get started:

```json
{
  "channel": {
    "feishu": {
      "enabled": true,
      "groupAllowFrom": ["ou_owner_xxx"],
      "accounts": {
        "cli_a_main_app_id": {
          "appSecret": "cli_a_main_app_secret",
          "bindings": {
            "dm": {
              "ou_owner_xxx": {
                "instanceId": "codex_cc"
              }
            },
            "group": {}
          }
        }
      }
    }
  }
}
```

In that minimal example, the fields users most often need explained are:

- `cli_a_main_app_id`
  This is the Feishu bot `AppID`. It is recommended to use the `AppID` directly as the key under `accounts`, which usually means you do not need to repeat an `appId` field.
- `cli_a_main_app_secret`
  This is the Feishu bot `App Secret`. You can get it from the `Credentials & Basic Info` section in the developer console.
- `ou_owner_xxx`
  This is a Feishu user's `openId`. It is commonly used for:
  - `groupAllowFrom`: who is allowed to trigger group messages
  - `bindings.dm`: which DM user should be bound to which Agent
- `instanceId`
  This is the key of an entry under `agents.instances` in the main Crewline config file `~/.crewline/crewline.json`, for example `codex_cc` or `claude_cc`. In other words, bindings point to an Agent instance, not directly to a model name.

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

then the valid `instanceId` values you can reference from Feishu bindings are:

- `codex_cc`
- `claude_cc`

If you want to configure a group binding, the shape is:

```json
"group": {
  "oc_group_xxx": {
    "instanceId": "claude_cc"
  }
}
```

Here:

- `oc_group_xxx`
  is the Feishu group `chatId`
- `claude_cc`
  is an instance ID you already defined under `agents.instances`

In short, the values come from:

- `AppID` / `App Secret`
  from the Feishu developer console, under `Credentials & Basic Info`
- user `openId`
  from inbound message logs under `~/.crewline/`, or from the official Feishu guide
- group `chatId`
  let the bot receive one message from that group, then inspect the inbound logs under `~/.crewline/`
- `instanceId`
  from the keys under `agents.instances` in `~/.crewline/crewline.json`

### 2.2 Multi-Account Example

If you need multiple bots, expand it like this:

```json
{
  "channel": {
    "feishu": {
      "enabled": true,
      "network": {
        "useSystemProxy": false
      },
      "requireMention": false,
      "groupAllowFrom": ["ou_owner_xxx"],
      "accounts": {
        "cli_a_main_app_id": {
          "appSecret": "cli_a_main_app_secret",
          "groups": {
            "oc_group_xxx": {
              "requireMention": false
            }
          },
          "bindings": {
            "dm": {
              "ou_owner_xxx": {
                "instanceId": "codex_cc"
              }
            },
            "group": {}
          }
        },
        "cli_a_review_app_id": {
          "appSecret": "cli_a_review_app_secret",
          "bindings": {
            "dm": {
              "ou_review": {
                "instanceId": "claude_cc"
              }
            },
            "group": {}
          }
        }
      }
    }
  }
}
```

### 2.3 Extra Scope Needed If You Want Group Replies Without @mentions

If you want the bot to reply in Feishu groups even when it is not mentioned, setting `requireMention=false` is not enough. You also need the sensitive app-identity scope:

- `im:message.group_msg`

In the developer console this corresponds to “get all group messages”.

### 2.4 How To Get A User's openId Before Binding

You can use either of these approaches:

1. If the channel is already configured and receiving messages, inspect inbound message logs under `~/.crewline/`.
2. Check the official Feishu troubleshooting doc:
   [How to obtain OpenID](https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-openid)

### 2.5 How To Enable Admin Commands

If you want to run admin commands over Feishu, configure allowed openIds under `channel.feishu.adminUserIds`, for example:

```json
{
  "channel": {
    "feishu": {
      "adminUserIds": ["ou_admin_xxx"]
    }
  }
}
```

Feishu currently supports:

- `/admin_help`
- `/admin_status`
- `/admin_health`
- `/admin_doctor feishu`
- `/admin_stop`
- `/admin_restart`
- `/admin_agents`
- `/admin_agent_add agentId=<agentId> providerId=<claude|codex> cwd=<cwd>`
- `/admin_agent_cwd agentId=<agentId> cwd=<cwd>`
- `/admin_reg`

Scope rules:

- most admin commands are DM-only
- `/admin_reg` is the exception; it can be used in Feishu DMs or groups to register the current conversation
- when `adminUserIds` is still empty, `/admin_reg` bootstraps the sender open_id and the current DM/group binding together

## 3. Defaults, Required Fields, And Optional Features

### 3.1 Merge Rules

- `channel.feishu` is the global default layer
- `channel.feishu.accounts.<appId>` is the account layer
- when the same field exists in both places, the global layer wins
- bindings should normally live under `accounts.<appId>.bindings.dm/group`
- `groups.<chatId>` only affects that group; `groups.*` can be used as a wildcard default

In practice:

- put shared policy in the global layer
  for example `enabled`, `requireMention`, `groupAllowFrom`, `network.useSystemProxy`
- put credentials and bindings in the account layer
  for example `appSecret`, `bindings`
- put one-off overrides in the group layer
  for example `groups.<chatId>.requireMention`

### 3.2 Required Fields

- `channel.feishu.enabled`
- `channel.feishu.groupAllowFrom`
- `channel.feishu.accounts.<appId>.appSecret`
- at least one `accounts.<appId>.bindings.dm` or `accounts.<appId>.bindings.group`

### 3.3 Key Fields

- `enabled`: whether Feishu is enabled
- `adminUserIds`: Feishu open_id values allowed to run admin commands
- `requireMention`: whether group messages must @ the bot
- `groupAllowFrom`: sender allowlist for group messages
- `network.useSystemProxy`: whether Feishu HTTP / WebSocket should inherit system proxy env vars
- `streaming`: whether streaming replies are enabled
- `footer.elapsed`: whether reply footers show elapsed time
- `footer.status`: whether reply footers show status
- `accounts`: multi-account map keyed by `appId`
- `accounts.<appId>.appId`: usually does not need to be repeated; by default the account key is used as the `appId`
- `accounts.<appId>.appSecret`: app secret for this bot
- `accounts.<appId>.bindings.dm`: DM bindings for this bot
- `accounts.<appId>.bindings.group`: group bindings for this bot
- `accounts.<appId>.groups.<chatId>`: per-group overrides for this bot

### 3.4 Defaults

- `enabled`: defaults to `false`
- `adminUserIds`: defaults to `[]`
- `requireMention`: defaults to `true`
- `network.useSystemProxy`: defaults to `false`
- `groupAllowFrom`: defaults to `[]`
- `streaming`: defaults to `false`
- `footer.elapsed`: defaults to `false`
- `footer.status`: defaults to `false`
- `groups`: defaults to `{}`

## 4. Pitfalls And Things To Watch

### 4.1 Group Message Safety Rules

Group delivery is evaluated in this order:

1. whether the group is enabled
2. whether the mention rule is satisfied
3. whether the sender is in the allow list

There is no implicit owner fallback anymore. For safety, `channel.feishu.groupAllowFrom` must be configured explicitly, and it is required at the global layer.

### 4.2 Proxy Behavior

By default Feishu does not inherit system proxy settings. Only set `channel.feishu.network.useSystemProxy` to `true` when you explicitly want Feishu HTTP / WebSocket traffic to follow `http_proxy` / `https_proxy`.

### 4.3 Permissions And Message Visibility

- The current mainline transport is WebSocket.
- Feishu group delivery still depends on the scopes granted to the app.
- If `requireMention` is `false`, make sure your app has the scope needed for ordinary group messages.

### 4.4 Fields You Usually Do Not Need

- `domain`
- `connectionMode`

These are not part of the main user-facing configuration path.

## Doctor

```bash
crewline doctor feishu
```
