import { toggleWechatDebugMode } from './wechat-debug.js';

function buildTimingText({ receivedAt, eventTimestamp }) {
  const platformDelay = eventTimestamp ? `${receivedAt - eventTimestamp}ms` : 'N/A';
  const pluginCost = `${Date.now() - receivedAt}ms`;
  return [
    '⏱ 通道耗时',
    `├ 事件时间: ${eventTimestamp ? new Date(eventTimestamp).toISOString() : 'N/A'}`,
    `├ 平台→插件: ${platformDelay}`,
    `└ 插件处理: ${pluginCost}`
  ].join('\n');
}

export function resolveWechatSlashCommand({ text, accountId, dataDir, receivedAt, eventTimestamp }) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIndex = trimmed.indexOf(' ');
  const command = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
  const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();

  if (command === '/echo') {
    return {
      handled: true,
      localReplyText: [args, buildTimingText({ receivedAt, eventTimestamp })].filter(Boolean).join('\n')
    };
  }

  if (command === '/toggle-debug') {
    const enabled = toggleWechatDebugMode(dataDir, accountId);
    return {
      handled: true,
      localReplyText: enabled ? 'Debug 模式已开启' : 'Debug 模式已关闭'
    };
  }

  return null;
}
