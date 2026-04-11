function appendFooter(text, { status, elapsedMs, footer = {} } = {}) {
  const lines = [text];
  const footerParts = [];
  if (footer.status) footerParts.push(`状态：${status ?? '已完成'}`);
  if (footer.elapsed && typeof elapsedMs === 'number') footerParts.push(`耗时：${(elapsedMs / 1000).toFixed(1)}s`);
  if (footerParts.length > 0) {
    lines.push('', footerParts.join(' · '));
  }
  return lines.join('\n').trim();
}

export function buildFeishuMarkdownCard(text) {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text
        }
      ]
    }
  };
}

function buildFeishuCardContent(text, { status, elapsedMs, footer = {} } = {}) {
  return JSON.stringify(buildFeishuMarkdownCard(
    appendFooter(text, { status, elapsedMs, footer })
  ));
}

async function createFeishuInteractiveReply({
  client,
  target,
  receiveIdType = 'chat_id',
  replyToMessageId,
  content
}) {
  const response = replyToMessageId
    ? await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'interactive',
          content
        }
      })
    : await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: target,
          msg_type: 'interactive',
          content
        }
      });

  return {
    ok: true,
    channel: 'feishu',
    messageId: response?.data?.message_id ?? null
  };
}

export async function patchFeishuReply({
  client,
  messageId,
  text,
  footer = {},
  status = '已完成',
  elapsedMs
}) {
  await client.im.message.patch({
    path: { message_id: messageId },
    data: {
      content: buildFeishuCardContent(text, { status, elapsedMs, footer })
    }
  });
  return {
    ok: true,
    channel: 'feishu',
    messageId
  };
}

export async function sendFeishuPendingReply({
  client,
  target,
  receiveIdType = 'chat_id',
  replyToMessageId,
  text = '…',
  footer = {},
  statusText = '生成中'
}) {
  return createFeishuInteractiveReply({
    client,
    target,
    receiveIdType,
    replyToMessageId,
    content: buildFeishuCardContent(text, { status: statusText, footer })
  });
}

export async function sendFeishuStreamingReply({
  client,
  target,
  receiveIdType = 'chat_id',
  replyToMessageId,
  chunks = [],
  finalText,
  footer = {},
  statusText = '生成中',
  elapsedMs
}) {
  let accumulated = '';
  const pending = await sendFeishuPendingReply({
    client,
    target,
    receiveIdType,
    replyToMessageId,
    text: accumulated || '…',
    footer,
    statusText
  });
  const messageId = pending.messageId;

  for await (const chunk of chunks) {
    accumulated += chunk;
    if (messageId && accumulated.trim()) {
      await patchFeishuReply({
        client,
        messageId,
        text: accumulated,
        footer,
        status: statusText
      });
    }
  }

  if (!messageId) return pending;
  return patchFeishuReply({
    client,
    messageId,
    text: finalText || accumulated || '…',
    footer,
    elapsedMs
  });
}

export function buildStaticFeishuReply(text, { footer = {}, elapsedMs } = {}) {
  return appendFooter(text, { status: '已完成', elapsedMs, footer });
}
