# WeChat 配置

[English](./wechat.md)

## 最小 `channel.wechat`

```json
{
  "channel": {
    "wechat": {
      "enabled": true,
      "bindings": {
        "dm": {
          "pending-wechat-user-id": {
            "instanceId": "codex_cc"
          }
        }
      }
    }
  }
}
```

## 首次登录

```bash
crewline wechat login
```

Crewline 会拉起扫码登录流程，在本地保存 WeChat 账号，并在条件满足时把占位绑定自动替换成真实 `wxid`。

## 常用字段

- `enabled`：必须设为 `true`
- `adminUserIds`：允许执行管理命令的 WeChat 用户 ID 列表
- `bindings.dm`：当前仅支持私聊绑定
- `apiBaseUrl`：可选 API 端点覆盖
- `cdnBaseUrl`：可选 CDN 端点覆盖
- `botType`：扫码登录使用的 bot 类型
- `loginTimeoutMs`：扫码登录超时
- `longPollTimeoutMs`：入站 long-poll 超时
- `allowRemoteMediaUrl`：可选，默认 `false`；只有在你明确可信任远端出站媒体 URL 时再开启

## 说明

- 当前入站模式是 long-poll。
- WeChat 登录状态保存在 `~/.crewline/channels/wechat/` 下。
- 登录阶段返回的 API 域名只有在命中受信任的 `*.weixin.qq.com` 主机时才会被保存。
- 建议优先使用本地文件路径作为出站媒体输入；远端媒体 URL 默认关闭。

## 管理命令

如果你希望通过 WeChat 执行管理命令，需要在 `channel.wechat.adminUserIds` 中配置允许的用户 ID。

当前 WeChat 支持：

- `/admin_help`
- `/admin_status`
- `/admin_health`
- `/admin_doctor wechat`
- `/admin_stop`
- `/admin_restart`
- `/admin_agents`
- `/admin_agent_add agentId=<agentId> providerId=<claude|codex> cwd=<cwd>`
- `/admin_agent_cwd agentId=<agentId> cwd=<cwd>`

作用范围：

- 只允许在 WeChat 私聊中执行
- 当前不支持 `/admin_reg`

## 自检

```bash
crewline doctor wechat
```
