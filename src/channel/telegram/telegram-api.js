import http from 'node:http';
import https from 'node:https';
import { randomId } from '../../shared/utils/ids.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function connectThroughProxy(proxyUrl, targetHost, targetPort, { timeoutMs } = {}) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        Connection: 'keep-alive',
        'Proxy-Connection': 'keep-alive',
        ...(proxy.username
          ? {
              'Proxy-Authorization': `Basic ${Buffer.from(
                `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
              ).toString('base64')}`
            }
          : {})
      }
    });
    req.setTimeout(timeoutMs ?? 10_000, () => {
      req.destroy(new Error(`Proxy CONNECT timed out after ${timeoutMs ?? 10_000}ms`));
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      socket.setKeepAlive(true, 30_000);
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsRequestOverSocket(socket, url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = https.request({
      socket,
      hostname: url.hostname,
      servername: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: Number(url.port) || 443,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        Connection: 'keep-alive'
      },
      agent: false
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

function httpsDownloadOverSocket(socket, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = https.request({
      socket,
      hostname: url.hostname,
      servername: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: Number(url.port) || 443,
      method: 'GET',
      headers: {
        Connection: 'keep-alive'
      },
      agent: false
    }, async (res) => {
      try {
        const data = await collectBuffer(res);
        clearTimeout(timer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Telegram file download failed: ${res.statusCode}`));
          return;
        }
        resolve(data);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

async function proxyFetchJson(url, payload, { timeoutSeconds, proxy }) {
  const target = new URL(url);
  const socket = await connectThroughProxy(proxy, target.hostname, Number(target.port) || 443, {
    timeoutMs: timeoutSeconds * 1000
  });
  try {
    const { status, data } = await httpsRequestOverSocket(socket, target, payload, timeoutSeconds * 1000);
    if (status < 200 || status >= 300 || data.ok === false) {
      throw new Error(data.description ?? `Telegram API error: ${status}`);
    }
    return data.result;
  } finally {
    socket.destroy();
  }
}

async function fetchJson(url, payload, { fetchImpl, timeoutSeconds }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(data.description ?? `Telegram API error: ${response.status}`);
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url, { fetchImpl, timeoutSeconds }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Telegram file download failed: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

export class TelegramBotApi {
  constructor({ token, baseUrl = 'https://api.telegram.org', timeoutSeconds = 30, proxy = null, fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutSeconds = timeoutSeconds;
    this.proxy = proxy;
    this.fetchImpl = fetchImpl;
  }

  methodUrl(method) {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  fileUrl(filePath) {
    return `${this.baseUrl}/file/bot${this.token}/${filePath.replace(/^\/+/, '')}`;
  }

  async call(method, payload = {}, { timeoutSeconds } = {}) {
    const url = this.methodUrl(method);
    const timeout = timeoutSeconds ?? this.timeoutSeconds;
    const normalized = payload.chat_id != null && !isNaN(payload.chat_id)
      ? { ...payload, chat_id: Number(payload.chat_id) }
      : payload;
    if (this.proxy) {
      return proxyFetchJson(url, normalized, {
        timeoutSeconds: timeout,
        proxy: this.proxy
      });
    }
    return fetchJson(url, normalized, { fetchImpl: this.fetchImpl, timeoutSeconds: timeout });
  }

  async getMe({ timeoutSeconds = this.timeoutSeconds } = {}) {
    return this.call('getMe', {}, { timeoutSeconds });
  }

  async getUpdates({ offset, timeoutSeconds = this.timeoutSeconds } = {}) {
    return this.call('getUpdates', { offset, timeout: timeoutSeconds }, {
      timeoutSeconds: timeoutSeconds + 10
    });
  }

  async getFile(fileId, { timeoutSeconds = this.timeoutSeconds } = {}) {
    return this.call('getFile', { file_id: fileId }, { timeoutSeconds });
  }

  async downloadFile(filePath, { timeoutSeconds = this.timeoutSeconds } = {}) {
    const url = this.fileUrl(filePath);
    if (this.proxy) {
      const target = new URL(url);
      const socket = await connectThroughProxy(this.proxy, target.hostname, Number(target.port) || 443, {
        timeoutMs: timeoutSeconds * 1000
      });
      try {
        return await httpsDownloadOverSocket(socket, target, timeoutSeconds * 1000);
      } finally {
        socket.destroy();
      }
    }
    return fetchBuffer(url, { fetchImpl: this.fetchImpl, timeoutSeconds });
  }

  async sendMessage({ chatId, messageThreadId, text, replyTo, meta = {} }) {
    return this.call('sendMessage', {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      text,
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
      ...meta
    });
  }

  async editMessageText({ chatId, messageId, messageThreadId, text, meta = {} }) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      message_thread_id: messageThreadId,
      text,
      ...meta
    });
  }

  async sendChatAction({ chatId, action = 'typing', messageThreadId }) {
    return this.call('sendChatAction', {
      chat_id: chatId,
      action,
      message_thread_id: messageThreadId
    }, { timeoutSeconds: 5 });
  }

  async streamText({ chatId, messageThreadId, chunks, initialText = '…', replyTo, meta = {} }) {
    const debounceMs = meta.debounceMs ?? 700;
    const minCharsBeforeFirstSend = meta.minCharsBeforeFirstSend ?? 16;
    const minCharsPerEdit = meta.minCharsPerEdit ?? 24;
    const firstSendNotBeforeMs = meta.firstSendNotBeforeMs ?? 0;
    const maxMessageLength = 4096;
    let latestText = '';
    let sentText = '';
    let messageId = null;
    let readerError = null;
    let done = false;
    let editFailures = 0;
    const maxEditFailures = 3;
    let stopped = false;

    const reader = (async () => {
      try {
        for await (const chunk of chunks) {
          latestText += chunk;
        }
      } catch (error) {
        readerError = error;
      } finally {
        done = true;
      }
    })();

    const clampText = (t) => {
      if (t.length <= maxMessageLength) return t;
      stopped = true;
      return t.slice(0, maxMessageLength - 1) + '…';
    };

    while (!done || latestText !== sentText) {
      if (editFailures >= maxEditFailures || stopped) break;

      const pendingText = latestText || initialText;
      const canFlushFirstMessage =
        !messageId && pendingText && (pendingText.length >= minCharsBeforeFirstSend || done);
      const canFlushEdit =
        messageId &&
        latestText !== sentText &&
        (latestText.length - sentText.length >= minCharsPerEdit || done);

      if (canFlushFirstMessage) {
        const waitMs = firstSendNotBeforeMs - Date.now();
        if (waitMs > 0) {
          await delay(waitMs);
          continue;
        }
        try {
          const preview = await this.sendMessage({
            chatId,
            messageThreadId,
            text: clampText(pendingText),
            replyTo
          });
          messageId = preview.message_id;
          sentText = latestText;
        } catch (error) {
          editFailures++;
        }
      } else if (canFlushEdit) {
        try {
          await this.editMessageText({
            chatId,
            messageId,
            messageThreadId,
            text: clampText(latestText)
          });
          sentText = latestText;
          editFailures = 0;
        } catch (error) {
          editFailures++;
        }
      }

      if (!done || latestText !== sentText) {
        await delay(debounceMs);
      }
    }

    await reader;
    if (readerError) throw readerError;

    if (!messageId) {
      try {
        const preview = await this.sendMessage({
          chatId,
          messageThreadId,
          text: clampText(latestText || initialText),
          replyTo
        });
        messageId = preview.message_id;
        sentText = latestText;
      } catch {
        // will be retried by caller via patchMessageId or fallback send
      }
    }

    return { messageId, text: sentText, streamId: randomId('tgstream') };
  }
}
