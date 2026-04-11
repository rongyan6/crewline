import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBotApi } from '../../src/channel/telegram/telegram-api.js';
import {
  createTelegramPollingErrorReporter,
  normalizeTelegramNetworkError
} from '../../src/channel/telegram/telegram-error-reporter.js';

function okResponse(result) {
  return {
    ok: true,
    json: async () => ({ ok: true, result })
  };
}

test('telegram api uses Bot API endpoint for sendMessage', async () => {
  const calls = [];
  const api = new TelegramBotApi({
    token: 'TOKEN',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return okResponse({ message_id: 1 });
    }
  });

  const result = await api.sendMessage({ chatId: '123', text: 'hi' });
  assert.equal(result.message_id, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/botTOKEN/sendMessage');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, 123);
  assert.equal(body.text, 'hi');
});

test('telegram api uses Bot API endpoint for getMe', async () => {
  const calls = [];
  const api = new TelegramBotApi({
    token: 'TOKEN',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return okResponse({ id: 1, username: 'crewline_bot' });
    }
  });

  const result = await api.getMe();
  assert.equal(result.username, 'crewline_bot');
  assert.equal(calls[0].url, 'https://api.telegram.org/botTOKEN/getMe');
});

test('telegram api includes message_thread_id when sending topic replies', async () => {
  const calls = [];
  const api = new TelegramBotApi({
    token: 'TOKEN',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return okResponse({ message_id: 1 });
    }
  });

  await api.sendMessage({ chatId: '123', messageThreadId: 42, text: 'hi' });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.message_thread_id, 42);
});

test('telegram api streamText sends preview then edits', async () => {
  const calls = [];
  const api = new TelegramBotApi({
    token: 'TOKEN',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/sendMessage')) return okResponse({ message_id: 9 });
      return okResponse({ message_id: 9 });
    }
  });

  async function* chunks() {
    yield 'hel';
    yield 'lo';
  }

  const result = await api.streamText({ chatId: '123', chunks: chunks() });
  assert.equal(result.messageId, 9);
  assert.equal(result.text, 'hello');
  assert.equal(calls.filter((call) => call.url.endsWith('/sendMessage')).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith('/editMessageText')).length, 0);
});

test('telegram api streamText waits until firstSendNotBeforeMs before first message', async () => {
  const calls = [];
  const startedAt = Date.now();
  const api = new TelegramBotApi({
    token: 'TOKEN',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, at: Date.now() });
      return okResponse({ message_id: 9 });
    }
  });

  async function* chunks() {
    yield 'hello world';
  }

  await api.streamText({
    chatId: '123',
    chunks: chunks(),
    meta: {
      minCharsBeforeFirstSend: 1,
      debounceMs: 1,
      firstSendNotBeforeMs: startedAt + 40
    }
  });

  assert.equal(calls.filter((call) => call.url.endsWith('/sendMessage')).length, 1);
  assert.equal(calls[0].at - startedAt >= 35, true);
});

test('normalizeTelegramNetworkError classifies transient proxy/tls failures', () => {
  const normalized = normalizeTelegramNetworkError(
    new Error('Client network socket disconnected before secure TLS connection was established')
  );
  assert.equal(normalized.startsWith('Transient proxy/TLS issue:'), true);
});

test('createTelegramPollingErrorReporter throttles duplicate warnings', () => {
  const logs = [];
  const reporter = createTelegramPollingErrorReporter({
    logger: { warn: (message) => logs.push(message) },
    windowMs: 60_000
  });

  reporter(new Error('socket hang up'));
  reporter(new Error('socket hang up'));
  reporter(new Error('socket hang up'));

  assert.equal(logs.length, 1);
});
