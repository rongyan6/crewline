# 飞书机器人配置

[English](./feishu.md)

## 1. 先把飞书机器人准备好

Crewline 只能消费你已经创建好的飞书应用 / 机器人。创建应用、开机器人、订阅事件、申请权限，这些前置步骤需要你在飞书开发者后台完成，AI 不能替你自动配置。

### 1.1 创建应用和机器人

1. 打开飞书开发者后台：
   [创建应用](https://open.feishu.cn/app?lang=zh-CN)
2. 创建完成后，在应用中添加能力，启用“机器人”。
3. 在“凭证与基础信息”菜单获取：
   - `AppID`
   - `App Secret`
4. 打开“事件与回调”菜单：
   - 订阅方式选择“长连接”
   - 添加事件 `im.message.receive_v1`

### 1.2 申请权限

如果使用插件、文档或群消息能力时遇到权限不足，可以在开发者后台这样操作：

1. 在左侧导航栏进入“权限管理”。
2. 点击“批量导入/导出权限”。
3. 在“导入”页签中，用下面这段权限 JSON 替换示例内容，然后点击“下一步”并确认“新增权限”。

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

4. 确认导入权限无误后，点击“申请开通”。
5. “应用身份权限”可访问的数据范围保持默认：
   `与应用的可用范围一致`
6. 点击“确认”完成申请。

## 2. 配置文件在哪，怎么配

Crewline 的主配置文件默认在：

- `~/.crewline/crewline.json`

推荐结构是：

- `channel.feishu`：全局默认策略
- `channel.feishu.accounts`：多账号配置，key 直接用 `appId`

当前代码的主路径就是多账号对象模型。即使你只有一个飞书机器人，也建议直接按 `accounts.<appId>` 写。

### 2.1 最小可用示例

前提：你已经在 `~/.crewline/crewline.json` 里配置好了 `agents.instances`，因为飞书绑定里的 `instanceId` 就来自这里。

下面这个例子已经够用：

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

这个最小示例里，用户最容易卡住的字段是：

- `cli_a_main_app_id`
  这是飞书机器人的 `AppID`。推荐直接把 `accounts` 的 key 写成 `AppID`，这样通常就不用再单独写 `appId` 字段了。
- `cli_a_main_app_secret`
  这是飞书机器人的 `App Secret`。在开发者后台的“凭证与基础信息”菜单获取。
- `ou_owner_xxx`
  这是飞书用户的 `openId`。它通常用于：
  - `groupAllowFrom`：允许谁触发群消息
  - `bindings.dm`：把哪个私聊用户绑定到哪个 Agent
- `instanceId`
  这里指的是 Crewline 主配置文件 `~/.crewline/crewline.json` 里 `agents.instances` 下某个实例的 key，例如 `codex_cc`、`claude_cc`。也就是说，`bindings` 绑定的是“聊天对象 -> Agent 实例”，不是直接绑定模型名。

  例如如果你的配置里有：

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

那么你在飞书绑定里可以写的 `instanceId` 就是：

- `codex_cc`
- `claude_cc`

如果你要配群绑定，写法是：

```json
"group": {
  "oc_group_xxx": {
    "instanceId": "claude_cc"
  }
}
```

其中：

- `oc_group_xxx`
  是飞书群的 `chatId`
- `claude_cc`
  是你在 `agents.instances` 里已经定义好的实例 ID

这些值的来源可以直接记成：

- `AppID` / `App Secret`
  在飞书开发者后台“凭证与基础信息”获取
- 用户 `openId`
  查看 `~/.crewline/` 下日志里的入站消息，或参考官方文档获取
- 群 `chatId`
  让机器人先收到一次该群消息，再从 `~/.crewline/` 下日志里的入站消息查看
- `instanceId`
  来自 `~/.crewline/crewline.json` 中 `agents.instances` 下的实例 key

### 2.2 多账号示例

如果你需要多账号，再扩成下面这样：

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

### 2.3 配置群里不 @ 也能回复时，需要额外申请什么

如果你希望机器人在飞书群里“不 @ 也可以回复”，除了把 `requireMention` 设为 `false`，还需要申请敏感权限：

- 应用身份权限：`im:message.group_msg`

也就是开发者后台里的“获取群组中所有消息（敏感权限）”。

### 2.4 配置绑定前，如何获取用户 openId

可以用下面两种方式：

1. 如果消息通道已经配置并且能正常收消息，查看 `~/.crewline/` 下的日志文件，找到对应入站消息里的发送者信息。
2. 查看飞书官方文档：
   [如何获取 OpenID](https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-openid)

### 2.5 管理命令怎么开

如果你希望通过飞书执行管理命令，需要在 `channel.feishu.adminUserIds` 里配置允许的 openId，例如：

```json
{
  "channel": {
    "feishu": {
      "adminUserIds": ["ou_admin_xxx"]
    }
  }
}
```

当前飞书支持：

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

作用范围：

- 大多数管理命令只允许私聊机器人时执行
- `/admin_reg` 例外，它允许在飞书私聊或群中执行，用来把当前会话注册到某个 Agent
- 当 `adminUserIds` 还是空数组时，`/admin_reg` 会同时把发送者 open_id 和当前私聊/群绑定一起自举写入配置

## 3. 默认配置、必配项、可选能力

### 3.1 配置合并规则

- `channel.feishu` 是全局默认层
- `channel.feishu.accounts.<appId>` 是账号层
- 同名字段同时存在时，全局层优先
- 路由绑定请优先写在 `accounts.<appId>.bindings.dm/group`
- `groups.<chatId>` 只影响对应群；`groups.*` 可以做通配默认

最常见的用法是：

- 全局层放通用策略
  例如 `enabled`、`requireMention`、`groupAllowFrom`、`network.useSystemProxy`
- 账号层放凭证和绑定
  例如 `appSecret`、`bindings`
- 群层放单群例外
  例如 `groups.<chatId>.requireMention`

### 3.2 必须配置的字段

- `channel.feishu.enabled`
- `channel.feishu.groupAllowFrom`
- `channel.feishu.accounts.<appId>.appSecret`
- 至少一条 `accounts.<appId>.bindings.dm` 或 `accounts.<appId>.bindings.group`

### 3.3 常用字段

- `enabled`：是否启用飞书通道
- `adminUserIds`：允许执行管理命令的飞书 open_id 列表
- `requireMention`：群消息是否必须 @ 机器人
- `groupAllowFrom`：群消息发送者白名单
- `network.useSystemProxy`：飞书 HTTP / WebSocket 是否继承系统代理环境变量
- `streaming`：是否启用流式回复
- `footer.elapsed`：回复 footer 是否展示耗时
- `footer.status`：回复 footer 是否展示状态
- `accounts`：多账号配置，key 推荐直接写 `appId`
- `accounts.<appId>.appId`：通常不用重复写；默认直接取账号 key 作为 `appId`
- `accounts.<appId>.appSecret`：该账号的 app secret
- `accounts.<appId>.bindings.dm`：该账号的私聊绑定
- `accounts.<appId>.bindings.group`：该账号的群绑定
- `accounts.<appId>.groups.<chatId>`：该账号下的群级覆盖配置

### 3.4 默认值

- `enabled`：默认 `false`
- `adminUserIds`：默认 `[]`
- `requireMention`：默认 `true`
- `network.useSystemProxy`：默认 `false`
- `groupAllowFrom`：默认 `[]`
- `streaming`：默认 `false`
- `footer.elapsed`：默认 `false`
- `footer.status`：默认 `false`
- `groups`：默认 `{}`

## 4. 有哪些坑或要关注的点

### 4.1 群消息安全规则

群消息是否会被处理，按下面顺序判断：

1. 群是否启用
2. 是否满足 mention 规则
3. 发送者是否在 allow list 中

当前代码不再对 owner 做任何隐式兜底。要保证安全性，`channel.feishu.groupAllowFrom` 必须显式配置，而且它是全局必填项。

### 4.2 代理行为

默认不会继承系统代理；只有在你明确希望飞书 HTTP / WebSocket 跟随 `http_proxy` / `https_proxy` 时，再把 `channel.feishu.network.useSystemProxy` 设为 `true`。

### 4.3 权限和消息可见性

- 当前主线接入方式是 WebSocket。
- Feishu 群消息是否能完整接收，仍取决于应用获得的权限范围。
- 如果 `requireMention` 设为 `false`，请确认应用具备接收群普通消息的权限。

## 自检

```bash
crewline doctor feishu
```
