# WeChat Configuration

[中文](./wechat.zh-CN.md)

## Minimal `channel.wechat`

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

## First Login

```bash
crewline wechat login
```

Crewline opens a QR-login flow, stores the WeChat account locally, and replaces the placeholder binding with the real `wxid` when possible.

## Key Fields

- `enabled`: must be `true`
- `adminUserIds`: WeChat user IDs allowed to run admin commands
- `bindings.dm`: currently only direct-message bindings are supported
- `apiBaseUrl`: optional API endpoint override
- `cdnBaseUrl`: optional CDN endpoint override
- `botType`: WeChat bot type passed to QR login
- `loginTimeoutMs`: QR login timeout
- `longPollTimeoutMs`: inbound long-poll timeout
- `allowRemoteMediaUrl`: optional; default `false`; keep disabled unless you explicitly trust outbound remote URLs

## Notes

- Inbound mode is long-poll.
- WeChat login state is stored under `~/.crewline/channels/wechat/`.
- Login responses are restricted to trusted `*.weixin.qq.com` hosts before Crewline stores returned API endpoints.
- Local file paths are the recommended outbound media input. Remote media URLs are disabled by default.

## Admin Commands

If you want to run admin commands over WeChat, configure allowed user IDs under `channel.wechat.adminUserIds`.

WeChat currently supports:

- `/admin_help`
- `/admin_status`
- `/admin_health`
- `/admin_doctor wechat`
- `/admin_stop`
- `/admin_restart`
- `/admin_agents`
- `/admin_agent_add agentId=<agentId> providerId=<claude|codex> cwd=<cwd>`
- `/admin_agent_cwd agentId=<agentId> cwd=<cwd>`

Scope rules:

- WeChat admin commands are DM-only
- `/admin_reg` is not supported on WeChat

## Doctor

```bash
crewline doctor wechat
```
