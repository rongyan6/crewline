# Crewline

[English](./README.md)

Crewline（发音近似 “crew-line”）是一个通过标准 IM 工具连接人和本地 AI Agent 协作的轻量网关。这个名字想表达的，就是“人与 Agents 协作的接入网关”。当前支持 Telegram、飞书、微信：Telegram 支持私聊、群聊、话题；飞书支持私聊和群聊；微信支持私聊。

这个项目的出发点，是希望通过成熟的 Claude Code、Codex CLI、Gemini CLI、Cursor CLI、GitHub Copilot CLI 等 ACP 兼容 Agent，在远程消息工具里和本地多 Agents 协作。通过 ACPX，Crewline 当前可对接 16 个内置 Agent 适配器，以及自定义 ACP Server。这里的 Agent 能力不只是 coding。相比 OpenClaw、Hermes Agent 这类更重的系统，Crewline 更强调轻量、配置简洁、服务形态清晰。

> 平台说明：
> 当前更推荐在 macOS 和 Linux 上安装使用。
> Windows 兼容性在持续改进，但现阶段测试还不够充分，使用时请额外注意。

## 内置 Agent 支持

当前内置支持的 Agent 包括 `pi`、`openclaw`、`codex`、`claude`、`gemini`、`cursor`、`copilot`、`droid`、`iflow`、`kilocode`、`kimi`、`kiro`、`opencode`、`qoder`、`qwen` 和 `trae`。

## 1. 安装

- Node.js `>= 22`

```bash
npm install -g crewline
```

安装完成后，就可以直接使用全局命令 `crewline`。

## 2. 初始化配置

直接生成默认配置：

```bash
crewline init
```

查看所有支持的命令：

```bash
crewline help
```

`crewline init` 会生成：

- `~/.crewline/crewline.json`

## 3. 配置 Crewline

先编辑 `~/.crewline/crewline.json`，把 agent instance 的 `cwd` 改成你真实希望 agent 操作的工作目录：

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
      "requireMention": true,
      "network": {
        "useSystemProxy": false
      },
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

这个阶段最关键的是两件事：

- 把本地 agent instance 的 `cwd` 改对
- 在你决定接入哪个消息通道之前，先保持对应 channel 为最小骨架

## 4. 配置消息通道

然后在 `~/.crewline/crewline.json` 里补上至少一个消息通道，并填写该通道所需设置。

详细说明请看：

- [Telegram 配置](./docs/guide/channels/telegram.zh-CN.md)
- [飞书机器人配置](./docs/guide/channels/feishu.zh-CN.md)
- [WeChat 配置](./docs/guide/channels/wechat.zh-CN.md)

例如：

```bash
# Telegram
# 把 botToken 配在 channel.telegram.accounts.<botId>.botToken

# Feishu
# 把 accounts.<appId>.appSecret 配在 channel.feishu.accounts 中
# AppId 通常直接写成 accounts 的 key

# WeChat
# 启用 channel.wechat 后执行首次扫码登录
crewline wechat login
```

## 5. 检查并启动

先检查配置：

```bash
crewline doctor
```

检查通过后，再启动服务：

```bash
crewline start
crewline status
crewline health
```

如果 `crewline doctor` 提示缺失项，就去补 `~/.crewline/crewline.json` 或对应通道配置，然后重新执行。

## 6. 服务管理

停止或重启：

```bash
crewline stop
crewline restart
```

如果你希望交给 macOS 的 launchd 管理：

```bash
crewline install
crewline uninstall
```

排查 channel 问题时，可以分别做自检：

```bash
crewline doctor telegram
crewline doctor feishu
crewline doctor wechat
```

WeChat 首次扫码登录：

```bash
crewline wechat login
```

## 7. 远程管理命令

Crewline 也支持通过 IM 执行一组远程管理命令。

当前支持：

- `/admin_help`：查看管理命令列表
- `/admin_status`：查看当前服务状态
- `/admin_health`：查看轻量健康摘要
- `/admin_doctor [telegram|feishu|wechat]`：执行配置或通道诊断
- `/admin_stop`：停止 Crewline 服务
- `/admin_restart`：重启 Crewline 服务
- `/admin_agents`：查看已配置的 agent 实例
- `/admin_agent_add agentId=<agentId> providerId=<claude|codex> cwd=<cwd>`：新增一个 agent 实例
- `/admin_agent_cwd agentId=<agentId> cwd=<cwd>`：修改已有 agent 实例的工作目录
- `/admin_reg`：在首次使用时注册当前 Telegram 私聊/群/Topic 或飞书私聊/群会话

权限和作用范围：

- 需要在 `~/.crewline/crewline.json` 里为对应通道配置 `adminUserIds`
- 大多数管理命令只允许在私聊中使用
- `/admin_reg` 是例外，用来注册当前 Telegram 私聊/群/Topic 或飞书私聊/群会话
- WeChat 支持私聊管理命令，但不支持 `/admin_reg`

行为说明：

- `/admin_agent_add` 和 `/admin_agent_cwd` 要求 `cwd` 必须是已存在的绝对路径
- `/admin_agent_add` 在 `agentId` 已存在时会失败
- `/admin_agent_cwd` 在 `agentId` 不存在时会失败
- `/admin_reg` 用于 Telegram 私聊/群/Topic 或飞书私聊/群的首次注册
- 如果当前通道还没有 `adminUserIds`，`/admin_reg` 会把发送者 ID 自举写入 `adminUserIds`，并写入当前会话绑定
- `/admin_reg` 仍然要求你先完成通道基础接入配置，例如 `channel.telegram.accounts.<botId>.botToken` 或 `channel.feishu.accounts.<appId>.appSecret`
- `/admin_stop`、`/admin_restart`、`/admin_agent_add`、`/admin_agent_cwd`、`/admin_reg` 这类会改服务状态或配置的命令，会在回执发出后再执行实际动作

## 8. 正常运行后你主要会接触到的文件

当 Crewline 正常运行后，用户最常接触的是这些内容：

- `~/.crewline/crewline.json`：主配置
- `~/.crewline/logs/`：运行日志

此外你还会看到 bindings、会话记录等运行期文件，它们属于正常运行数据，通常不需要手动编辑。

## 一个典型的首次使用流程

```bash
crewline init
crewline help
# 编辑 ~/.crewline/crewline.json
crewline doctor
crewline start
crewline status
```

## 备注

- 更详细的文档入口在 [`docs/`](./docs/README.zh-CN.md)。

## 在你自己的 Agent 中使用 Crewline 运维技能

仓库里还附带了一个可复用的配置与运维技能：

- [`docs/skills/crewline-config-and-operations/SKILL.md`](./docs/skills/crewline-config-and-operations/SKILL.md)

如果你自己的 Agent 支持本地 skill 或可安装 skill，可以把这个文件接进去，让它在下面这些场景中使用：

- 配置 `crewline.json`
- 配置 Telegram / 飞书 / WeChat 通道
- 执行 doctor / status / health 检查
- 理解管理命令的行为和限制
- 排查启动、绑定、路由、服务运维相关问题

实际使用时，最好让你的 Agent 同时具备：

1. 访问本机 Crewline 配置文件的能力
2. 访问安装目录下文档或本 GitHub 仓库文档的能力
3. 执行 `crewline doctor`、`crewline status`、`crewline restart` 这类运维命令的能力

## 关注微信公众号

欢迎关注微信公众号，获取最新动态：

![Crewline 微信公众号](./docs/images/wechat-qrcode.jpg)
