# Telegram 配置

[English](./telegram.md)

## 1. 先把 Telegram 机器人准备好

Crewline 只能消费你已经创建好的 Telegram 机器人。创建机器人、获取 token、关闭隐私模式，这些前置步骤需要你自己在 Telegram / @BotFather 中完成，AI 不能替你自动配置。

### 1.1 创建机器人

1. 在 Telegram 中搜索并打开 [@BotFather](https://t.me/BotFather)。
2. 发送 `/newbot`。
3. 按提示设置：
   - 机器人显示名
   - 机器人用户名
4. 创建完成后，@BotFather 会返回一个 bot token。

Telegram 官方资料：

- [Telegram Bots: Introduction](https://core.telegram.org/bots)
- [From BotFather to “Hello World”](https://core.telegram.org/bots/tutorial)

### 1.2 获取 token

- bot token 就是 @BotFather 在创建成功后返回的那串密钥
- 它看起来通常像这样：
  `1234567890:AA...`
- 请把它当密码保管，不要泄露

### 1.3 获取 bot ID

在 Crewline 的多账号配置里，`channel.telegram.accounts` 的 key 推荐直接使用 bot 的数字 ID。

可以用两种方式得到：

1. 直接看 token 冒号前面的数字部分
   例如：
   `1234567890:AA...`
   这里的 bot ID 就是 `1234567890`
2. 调用 Telegram Bot API 的 `getMe`
   Telegram 官方 Bot API 文档：
   [getMe / Bot API](https://core.telegram.org/bots/api)

当前 Crewline 的代码要求：

- `accounts.<botId>` 里的 key 必须和 token 的数字前缀一致

### 1.4 如果希望群里不必 @ 也能收到消息，要关闭隐私模式

Telegram 官方 FAQ 说明：

- 开启隐私模式时，机器人在群里只能收到“与它相关”的消息
- 关闭隐私模式后，机器人会收到群里的普通消息（除了其他 bot 发出的消息）

参考：
- [Bots FAQ](https://core.telegram.org/bots/faq)

常见做法是在 [@BotFather](https://t.me/BotFather) 里关闭 Privacy Mode：

- 可通过 `/setprivacy`
- 或 Bot Settings 里的 Group Privacy

如果你希望群聊或 Topic 中“不 @ 机器人也能回复”，通常要同时满足：

1. 在 @BotFather 中关闭隐私模式
2. 在 Crewline 配置里把 `requireMention.group` 或 `requireMention.topic` 设为 `false`

## 2. 配置文件在哪，怎么配

Crewline 的主配置文件默认在：

- `~/.crewline/crewline.json`

推荐结构是：

- `channel.telegram`：全局默认策略
- `channel.telegram.accounts`：多账号配置，key 直接用 bot ID

即使你只有一个 Telegram 机器人，也建议直接按 `accounts.<botId>` 写。

### 2.1 最小可用示例

前提：你已经在 `~/.crewline/crewline.json` 里配置好了 `agents.instances`，因为 Telegram 绑定里的 `instanceId` 就来自这里。

下面这个例子已经够用：

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

这个最小示例里，用户最容易卡住的字段是：

- `1234567890`
  这是 Telegram 机器人的 bot ID，也是 `accounts` 的 key。当前 Crewline 要求它和 token 冒号前面的数字前缀一致。
- `1234567890:AAxxxxxxxx...`
  这是 Telegram 机器人的 bot token，在 @BotFather 创建机器人时获取。
- `8657006361`
  这是 Telegram 用户 ID。它通常用于：
  - `groupAllowFrom`：允许谁触发群聊 / Topic 消息
  - `bindings.dm`：把哪个私聊用户绑定到哪个 Agent
- `instanceId`
  这里指的是 Crewline 主配置文件 `~/.crewline/crewline.json` 里 `agents.instances` 下某个实例的 key，例如 `codex_cc`、`claude_cc`

例如如果你的配置里有：

```json
"agents": {
  "instances": {
    "codex_cc": {
      "providerId": "codex",
      "model": "gpt-5.5[medium]",
      "cwd": "/Users/you/code/project-a"
    },
    "claude_cc": {
      "providerId": "claude",
      "cwd": "/Users/you/code/project-b"
    }
  }
}
```

那么你在 Telegram 绑定里可以写的 `instanceId` 就是：

- `codex_cc`
- `claude_cc`

如果你要配群绑定，写法是：

```json
"group": {
  "-1001234567890": {
    "instanceId": "claude_cc"
  }
}
```

如果你要配 Topic 绑定，写法是：

```json
"topic": {
  "-1001234567890:42": {
    "instanceId": "codex_cc"
  }
}
```

这些值的来源可以简单记成：

- bot token
  在 @BotFather 创建机器人时获取
- bot ID
  从 token 冒号前数字部分获取，或调用 `getMe`
- 用户 ID / 群 ID / Topic ID
  让机器人先收到一次消息，再查看 `~/.crewline/` 下日志或入站记录
- `instanceId`
  来自 `~/.crewline/crewline.json` 中 `agents.instances` 下的实例 key

### 2.2 多账号示例

如果你需要多账号，再扩成下面这样：

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

### 2.3 配置绑定前，怎么拿用户 ID / 群 ID / Topic ID

常见做法是：

1. 先让机器人收到一条目标消息
   - 私聊：让该用户私聊机器人一次
   - 群聊：让群里发一条消息
   - Topic：让目标 Topic 发一条消息
2. 查看 `~/.crewline/` 下的日志或入站记录

通常你会看到：

- 用户 ID：对应发送者
- 群 ID：对应 `chat.id`
- Topic ID：对应 `message_thread_id`

### 2.4 管理命令怎么开

如果你希望通过 Telegram 执行管理命令，需要在对应通道配置里补 `adminUserIds`，例如：

```json
{
  "channel": {
    "telegram": {
      "adminUserIds": ["8657006361"]
    }
  }
}
```

当前 Telegram 支持：

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

作用范围：

- 大多数管理命令只允许私聊机器人时执行
- `/admin_reg` 例外，它允许在 Telegram 私聊、群聊或 Topic 中执行，用来把当前会话注册到某个 Agent
- `/admin_user` 只允许私聊机器人时执行
- 当 `adminUserIds` 还是空数组时，`/admin_reg` 会同时把发送者 Telegram 用户 ID 和当前私聊/群/Topic 绑定一起自举写入配置

已绑定的 Telegram 会话里还支持这些 Crewline 内置会话命令：

- `/reset`：重建当前 Agent runtime 会话，但不清空聊天记录，也不改变绑定
- 后续会继续补充更多 Crewline 内置会话命令
- `/new` 不由 Crewline 处理；如果底层 provider 支持，它会被原样透传给底层 Agent runtime

## 3. 默认配置、必配项、可选能力

### 3.1 配置合并规则

- `channel.telegram` 是全局默认层
- `channel.telegram.accounts.<botId>` 是账号层
- 同名字段同时存在时，账号层覆盖全局层
- 路由绑定一般写在 `accounts.<botId>.bindings.dm/group/topic`
- `groups.<chatId>` 只影响对应群
- `topics.<chatId>:<topicId>` 只影响对应 Topic

最常见的用法是：

- 全局层放通用策略
  例如 `groupAllowFrom`、`requireMention`、`streaming`、`network.proxy`
- 账号层放 token 和绑定
  例如 `botToken`、`bindings`
- 群 / Topic 层放单点例外
  例如 `groups.<chatId>.requireMention`

### 3.2 必须配置的字段

- `channel.telegram.accounts.<botId>.botToken`
- 至少一条 `bindings.dm`、`bindings.group` 或 `bindings.topic`
- 如果你要用群聊 / Topic，建议显式配置 `channel.telegram.groupAllowFrom`

### 3.3 常用字段

- `adminUserIds`：允许执行管理命令的 Telegram 用户 ID 列表
- `groupAllowFrom`：群聊 / Topic 发送者白名单
- `requireMention.group`：群聊是否必须 `@机器人`
- `requireMention.topic`：Topic 是否必须 `@机器人`
- `streaming`：是否启用流式编辑回复
- `network.proxy`：Telegram API 的 HTTP 代理
- `accounts`：多账号配置，key 推荐直接写 bot ID
- `accounts.<botId>.botToken`：该账号对应的 token
- `accounts.<botId>.bindings.dm`：私聊绑定
- `accounts.<botId>.bindings.group`：群聊绑定
- `accounts.<botId>.bindings.topic`：Topic 绑定
- `groups.<chatId>.groupAllowFrom`：群级白名单覆盖
- `topics.<chatId>:<topicId>.groupAllowFrom`：Topic 级白名单覆盖

### 3.4 默认值

- `adminUserIds`：默认 `[]`
- `groupAllowFrom`：默认 `[]`
- `requireMention.group`：默认 `false`
- `requireMention.topic`：默认 `false`
- `streaming`：默认 `false`
- `network.proxy`：默认 `null`
- `network.autoSelectFamily`：默认 `true`
- `network.dangerouslyAllowPrivateNetwork`：默认 `false`
- `polling.timeoutSeconds`：默认 `30`
- `groups`：默认 `{}`
- `topics`：默认 `{}`

## 4. 有哪些坑或要关注的点

### 4.1 群里不 @ 也能回复，不只是一项配置

如果你希望机器人在群聊 / Topic 里不需要 `@` 就能收到普通消息，通常要同时满足：

1. 关闭 Telegram 机器人的 Privacy Mode
2. 把 `requireMention.group` 或 `requireMention.topic` 设为 `false`
3. 把发送者加入 `groupAllowFrom`

只改其中一项，往往不够。

### 4.2 当前主线路径是 polling

- 当前主线运行模式是 polling
- 配置层保留了 webhook 字段，但不是当前主线使用方式

### 4.3 群和 Topic 的绑定 key 不一样

- 群绑定 key 是 `chatId`
- Topic 绑定 key 是 `<chatId>:<topicId>`

如果写错格式，Crewline 不会命中对应的 Topic 绑定。

### 4.4 token 和 bot ID 必须一致

当前 Crewline 会校验：

- `accounts.<botId>` 的 key
- 必须与 `botToken` 冒号前的数字前缀一致

这一步写错时，配置校验会直接失败。

## 自检

```bash
crewline doctor telegram
```
