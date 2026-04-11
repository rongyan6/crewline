import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CrewlineError } from '../../shared/errors/error-envelope.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';
import { sendWechatMediaFile } from './wechat-media.js';

export const WECHAT_CHANNEL_ID = 'wechat';
export const WECHAT_PROVIDER_ID = 'crewline-wechat';
export const DEFAULT_WECHAT_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const DEFAULT_WECHAT_BOT_TYPE = '3';

const WECHAT_PLUGIN_VERSION = '2.1.6';
const WECHAT_ILINK_APP_ID = 'bot';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_STATUS_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000;
const TRUSTED_WECHAT_HOST_PATTERN = /(^|\.)weixin\.qq\.com$/i;

const activeLogins = new Map();
const sessionPauseUntil = new Map();

function createWechatError(message, cause, details = {}) {
  return new CrewlineError({
    code: ErrorCodes.CHANNEL_UNAVAILABLE,
    layer: 'channel',
    recoverable: true,
    message,
    cause,
    details
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function isTrustedWechatHostname(hostname) {
  return TRUSTED_WECHAT_HOST_PATTERN.test(String(hostname ?? '').trim());
}

function resolveTrustedWechatBaseUrl(baseUrl, { source } = {}) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' || !isTrustedWechatHostname(parsed.hostname)) {
      throw new Error('untrusted host');
    }
    return parsed.origin;
  } catch (error) {
    throw createWechatError(`Untrusted WeChat API host from ${source ?? 'remote response'}`, error, {
      source,
      baseUrl
    });
  }
}

function resolveTrustedWechatRedirectBaseUrl(redirectHost) {
  return resolveTrustedWechatBaseUrl(`https://${String(redirectHost ?? '').trim()}`, {
    source: 'redirect_host'
  });
}

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split('.')
    .map((item) => Number.parseInt(item, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function buildBaseInfo() {
  return {
    channel_version: WECHAT_PLUGIN_VERSION
  };
}

function buildCommonHeaders() {
  return {
    'iLink-App-Id': WECHAT_ILINK_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(WECHAT_PLUGIN_VERSION))
  };
}

function buildHeaders({ token, body }) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders()
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function createWechatApi({ account, bridgeConfig, fetchImpl = fetch }) {
  const baseUrl = account.baseUrl ?? bridgeConfig.apiBaseUrl;
  const token = account.token;
  return {
    async sendMessage(body) {
      return JSON.parse(await apiPostFetch({
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        body: JSON.stringify({ ...body, base_info: buildBaseInfo() }),
        token,
        timeoutMs: 15_000,
        label: 'sendMessage',
        fetchImpl
      }) || '{}');
    },
    async getUploadUrl(payload) {
      return JSON.parse(await apiPostFetch({
        baseUrl,
        endpoint: 'ilink/bot/getuploadurl',
        body: JSON.stringify({ ...payload, base_info: buildBaseInfo() }),
        token,
        timeoutMs: 15_000,
        label: 'getUploadUrl',
        fetchImpl
      }) || '{}');
    },
    async getConfig({ ilinkUserId, contextToken }) {
      return JSON.parse(await apiPostFetch({
        baseUrl,
        endpoint: 'ilink/bot/getconfig',
        body: JSON.stringify({
          ilink_user_id: ilinkUserId,
          context_token: contextToken,
          base_info: buildBaseInfo()
        }),
        token,
        timeoutMs: 10_000,
        label: 'getConfig',
        fetchImpl
      }) || '{}');
    },
    async sendTyping({ ilinkUserId, typingTicket, status }) {
      return JSON.parse(await apiPostFetch({
        baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        body: JSON.stringify({
          ilink_user_id: ilinkUserId,
          typing_ticket: typingTicket,
          status,
          base_info: buildBaseInfo()
        }),
        token,
        timeoutMs: 10_000,
        label: 'sendTyping',
        fetchImpl
      }) || '{}');
    }
  };
}

export function pauseWechatSession(accountId) {
  sessionPauseUntil.set(accountId, Date.now() + SESSION_PAUSE_DURATION_MS);
}

export function getRemainingWechatPauseMs(accountId) {
  const until = sessionPauseUntil.get(accountId);
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    sessionPauseUntil.delete(accountId);
    return 0;
  }
  return remaining;
}

export function assertWechatSessionActive(accountId) {
  const remainingMs = getRemainingWechatPauseMs(accountId);
  if (remainingMs > 0) {
    throw createWechatError(`WeChat session paused for ${Math.ceil(remainingMs / 60000)} min`, undefined, {
      accountId,
      remainingMs,
      errcode: SESSION_EXPIRED_ERRCODE
    });
  }
}

export function resolveWechatBridgeConfig(config = {}, { dataDir } = {}) {
  return {
    enabled: config.enabled === true,
    apiBaseUrl: config.apiBaseUrl ?? DEFAULT_WECHAT_API_BASE_URL,
    cdnBaseUrl: config.cdnBaseUrl ?? DEFAULT_WECHAT_CDN_BASE_URL,
    botType: String(config.botType ?? DEFAULT_WECHAT_BOT_TYPE),
    longPollTimeoutMs: Number(config.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS),
    loginTimeoutMs: Number(config.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS),
    pollRetryDelayMs: Number(config.pollRetryDelayMs ?? 2_000),
    pollBackoffDelayMs: Number(config.pollBackoffDelayMs ?? 30_000),
    maxConsecutiveFailures: Number(config.maxConsecutiveFailures ?? 3),
    stateDir: path.join(dataDir ?? process.cwd(), 'channels', 'wechat'),
    bindings: config.bindings ?? { dm: {} }
  };
}

function resolveAccountsDir(bridgeConfig) {
  return path.join(bridgeConfig.stateDir, 'accounts');
}

function resolveAccountFilePath(bridgeConfig, accountId) {
  return path.join(resolveAccountsDir(bridgeConfig), `${accountId}.json`);
}

function resolveSyncBufFilePath(bridgeConfig, accountId) {
  return path.join(resolveAccountsDir(bridgeConfig), `${accountId}.sync.json`);
}

function resolveContextTokenFilePath(bridgeConfig, accountId) {
  return path.join(resolveAccountsDir(bridgeConfig), `${accountId}.context-tokens.json`);
}

export function listWechatAccounts({ bridgeConfig }) {
  const dir = resolveAccountsDir(bridgeConfig);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.sync.json') && !name.endsWith('.context-tokens.json'))
    .map((name) => parseJsonFile(path.join(dir, name), null))
    .filter(Boolean)
    .map((record) => ({
      accountId: record.accountId,
      token: record.token,
      baseUrl: record.baseUrl ?? bridgeConfig.apiBaseUrl,
      cdnBaseUrl: record.cdnBaseUrl ?? bridgeConfig.cdnBaseUrl,
      userId: record.userId ?? null,
      savedAt: record.savedAt ?? null
    }))
    .filter((record) => typeof record.accountId === 'string' && record.accountId);
}

export function loadWechatAccount({ bridgeConfig, accountId }) {
  return parseJsonFile(resolveAccountFilePath(bridgeConfig, accountId), null);
}

export function saveWechatAccount({ bridgeConfig, accountId, account }) {
  const next = {
    accountId,
    token: account.token,
    baseUrl: account.baseUrl ?? bridgeConfig.apiBaseUrl,
    cdnBaseUrl: account.cdnBaseUrl ?? bridgeConfig.cdnBaseUrl,
    userId: account.userId ?? null,
    savedAt: new Date().toISOString()
  };
  writeJsonFile(resolveAccountFilePath(bridgeConfig, accountId), next);
  if (next.userId) {
    for (const existing of listWechatAccounts({ bridgeConfig })) {
      if (existing.accountId !== accountId && existing.userId === next.userId) {
        try {
          fs.rmSync(resolveAccountFilePath(bridgeConfig, existing.accountId), { force: true });
          fs.rmSync(resolveSyncBufFilePath(bridgeConfig, existing.accountId), { force: true });
          fs.rmSync(resolveContextTokenFilePath(bridgeConfig, existing.accountId), { force: true });
        } catch {}
      }
    }
  }
  return next;
}

export function loadContextTokens({ bridgeConfig, accountId }) {
  return parseJsonFile(resolveContextTokenFilePath(bridgeConfig, accountId), {});
}

export function saveContextToken({ bridgeConfig, accountId, userId, contextToken }) {
  if (!userId || !contextToken) return;
  const tokens = loadContextTokens({ bridgeConfig, accountId });
  tokens[userId] = contextToken;
  writeJsonFile(resolveContextTokenFilePath(bridgeConfig, accountId), tokens);
}

export function getContextToken({ bridgeConfig, accountId, userId }) {
  const tokens = loadContextTokens({ bridgeConfig, accountId });
  return typeof tokens[userId] === 'string' ? tokens[userId] : undefined;
}

export function loadGetUpdatesBuf({ bridgeConfig, accountId }) {
  const payload = parseJsonFile(resolveSyncBufFilePath(bridgeConfig, accountId), {});
  return typeof payload.get_updates_buf === 'string' ? payload.get_updates_buf : '';
}

export function saveGetUpdatesBuf({ bridgeConfig, accountId, getUpdatesBuf }) {
  writeJsonFile(resolveSyncBufFilePath(bridgeConfig, accountId), {
    get_updates_buf: getUpdatesBuf
  });
}

async function apiGetFetch({
  baseUrl,
  endpoint,
  label,
  timeoutMs,
  fetchImpl = fetch
}) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(new URL(endpoint, ensureTrailingSlash(baseUrl)), {
      method: 'GET',
      headers: buildCommonHeaders(),
      signal: controller?.signal
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw createWechatError(`${label} failed`, undefined, {
        status: response.status,
        body: rawText
      });
    }
    return rawText;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function apiPostFetch({
  baseUrl,
  endpoint,
  body,
  token,
  label,
  timeoutMs,
  fetchImpl = fetch
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL(endpoint, ensureTrailingSlash(baseUrl)), {
      method: 'POST',
      headers: buildHeaders({ token, body }),
      body,
      signal: controller.signal
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw createWechatError(`${label} failed`, undefined, {
        status: response.status,
        body: rawText
      });
    }
    return rawText;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchQRCode({ apiBaseUrl, botType, fetchImpl }) {
  return JSON.parse(await apiGetFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: 'fetchQRCode',
    fetchImpl
  }));
}

async function pollQRStatus({ apiBaseUrl, qrcode, fetchImpl }) {
  try {
    return JSON.parse(await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      label: 'pollQRStatus',
      timeoutMs: QR_STATUS_TIMEOUT_MS,
      fetchImpl
    }));
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { status: 'wait' };
    }
    return { status: 'wait', error: error?.message ?? String(error) };
  }
}

function isLoginFresh(login) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins() {
  for (const [sessionKey, login] of activeLogins.entries()) {
    if (!isLoginFresh(login)) activeLogins.delete(sessionKey);
  }
}

export async function loginWechatChannel({
  config = {},
  dataDir,
  fetchImpl = fetch,
  onStatus = () => {},
  print = (message) => process.stdout.write(String(message)),
  force = false
} = {}) {
  const bridgeConfig = resolveWechatBridgeConfig(config, { dataDir });
  const sessionKey = crypto.randomUUID();

  purgeExpiredLogins();
  if (!force) {
    const existing = activeLogins.get(sessionKey);
    if (existing && isLoginFresh(existing)) {
      return {
        ok: false,
        sessionKey,
        qrcodeUrl: existing.qrcodeUrl,
        message: '已有进行中的微信登录会话'
      };
    }
  }

  const qr = await fetchQRCode({
    apiBaseUrl: DEFAULT_WECHAT_API_BASE_URL,
    botType: bridgeConfig.botType,
    fetchImpl
  });
  const activeLogin = {
    sessionKey,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: Date.now(),
    currentApiBaseUrl: DEFAULT_WECHAT_API_BASE_URL
  };
  activeLogins.set(sessionKey, activeLogin);
  onStatus({ phase: 'qrcode', qrcodeUrl: qr.qrcode_img_content });
  print('请使用微信扫码登录：\n');
  try {
    const qrcodeTerminal = await import('qrcode-terminal');
    await new Promise((resolve) => {
      qrcodeTerminal.default.generate(qr.qrcode_img_content, { small: true }, (qrText) => {
        print(`${qrText}\n`);
        resolve();
      });
    });
    print(`如果二维码未能成功展示，请打开以下链接扫码：\n${qr.qrcode_img_content}\n`);
  } catch {
    print(`${qr.qrcode_img_content}\n`);
  }

  const deadline = Date.now() + bridgeConfig.loginTimeoutMs;
  let refreshCount = 1;

  while (Date.now() < deadline) {
    const status = await pollQRStatus({
      apiBaseUrl: activeLogin.currentApiBaseUrl,
      qrcode: activeLogin.qrcode,
      fetchImpl
    });
    activeLogin.status = status.status;
    onStatus({ phase: 'poll', status: status.status });

    if (status.status === 'scaned') {
      print('已扫码，请在微信内确认登录。\n');
    }

    if (status.status === 'scaned_but_redirect' && status.redirect_host) {
      try {
        activeLogin.currentApiBaseUrl = resolveTrustedWechatRedirectBaseUrl(status.redirect_host);
      } catch {
        activeLogins.delete(sessionKey);
        return {
          ok: false,
          sessionKey,
          qrcodeUrl: activeLogin.qrcodeUrl,
          message: '登录返回了不受信任的微信 API 域名'
        };
      }
    }

    if (status.status === 'expired') {
      refreshCount += 1;
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        activeLogins.delete(sessionKey);
        return {
          ok: false,
          sessionKey,
          message: '二维码多次过期，请重新执行登录'
        };
      }
      const nextQr = await fetchQRCode({
        apiBaseUrl: DEFAULT_WECHAT_API_BASE_URL,
        botType: bridgeConfig.botType,
        fetchImpl
      });
      activeLogin.qrcode = nextQr.qrcode;
      activeLogin.qrcodeUrl = nextQr.qrcode_img_content;
      activeLogin.startedAt = Date.now();
      activeLogin.currentApiBaseUrl = DEFAULT_WECHAT_API_BASE_URL;
      print('二维码已刷新，请重新扫码：\n');
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        await new Promise((resolve) => {
          qrcodeTerminal.default.generate(nextQr.qrcode_img_content, { small: true }, (qrText) => {
            print(`${qrText}\n`);
            resolve();
          });
        });
        print(`如果二维码未能成功展示，请打开以下链接扫码：\n${nextQr.qrcode_img_content}\n`);
      } catch {
        print(`${nextQr.qrcode_img_content}\n`);
      }
      continue;
    }

    if (status.status === 'confirmed') {
      activeLogins.delete(sessionKey);
      if (!status.ilink_bot_id || !status.bot_token) {
        return {
          ok: false,
          sessionKey,
          message: '登录成功回调缺少账号信息'
        };
      }
      let trustedBaseUrl;
      try {
        trustedBaseUrl = resolveTrustedWechatBaseUrl(status.baseurl ?? bridgeConfig.apiBaseUrl, {
          source: 'login confirmation'
        });
      } catch {
        return {
          ok: false,
          sessionKey,
          qrcodeUrl: qr.qrcode_img_content,
          message: '登录返回了不受信任的微信 API 域名'
        };
      }
      const saved = saveWechatAccount({
        bridgeConfig,
        accountId: status.ilink_bot_id,
        account: {
          token: status.bot_token,
          baseUrl: trustedBaseUrl,
          cdnBaseUrl: bridgeConfig.cdnBaseUrl,
          userId: status.ilink_user_id ?? null
        }
      });
      return {
        ok: true,
        sessionKey,
        qrcodeUrl: qr.qrcode_img_content,
        accountId: saved.accountId,
        userId: saved.userId,
        baseUrl: saved.baseUrl,
        message: '微信登录成功'
      };
    }

    await sleep(1000);
  }

  activeLogins.delete(sessionKey);
  return {
    ok: false,
    sessionKey,
    qrcodeUrl: qr.qrcode_img_content,
    message: '登录超时，请重试'
  };
}

export async function getUpdates({
  baseUrl,
  token,
  getUpdatesBuf = '',
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
  fetchImpl = fetch
}) {
  try {
    return JSON.parse(await apiPostFetch({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: buildBaseInfo()
      }),
      token,
      timeoutMs,
      label: 'getUpdates',
      fetchImpl
    }));
  } catch (error) {
    if (error?.name === 'AbortError') {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: getUpdatesBuf
      };
    }
    throw error;
  }
}

function textFromItemList(itemList = []) {
  for (const item of itemList) {
    if (item?.type === 1 && item?.text_item?.text != null) {
      return String(item.text_item.text);
    }
    if (item?.type === 3 && item?.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  const firstType = itemList[0]?.type;
  if (firstType === 2) return '用户发送了一张微信图片。';
  if (firstType === 3) return '用户发送了一条微信语音。';
  if (firstType === 4) return `用户发送了一个微信文件${itemList[0]?.file_item?.file_name ? `：${itemList[0].file_item.file_name}` : '。'}`;
  if (firstType === 5) return '用户发送了一个微信视频。';
  return '';
}

export function normalizeWechatInboundEvent({ accountId, message, bridgeConfig }) {
  const fromUserId = String(message?.from_user_id ?? '');
  if (!fromUserId) return null;
  if (message?.context_token) {
    saveContextToken({
      bridgeConfig,
      accountId,
      userId: fromUserId,
      contextToken: message.context_token
    });
  }
  return {
    accountId,
    conversationRef: {
      channel: WECHAT_CHANNEL_ID,
      accountId,
      conversationId: fromUserId,
      participantId: fromUserId,
      scope: 'dm'
    },
    senderRef: {
      userId: fromUserId,
      displayName: fromUserId,
      username: fromUserId
    },
    messageId: String(message?.message_id ?? message?.seq ?? crypto.randomUUID()),
    text: textFromItemList(message?.item_list ?? []),
    timestamp: new Date(Number(message?.create_time_ms ?? Date.now())).toISOString(),
    rawMeta: {
      provider: WECHAT_PROVIDER_ID,
      contextToken: message?.context_token ?? null,
      sessionId: message?.session_id ?? null,
      itemList: message?.item_list ?? []
    }
  };
}

export async function sendWechatMessage({
  config = {},
  dataDir,
  outboundMessage,
  fetchImpl = fetch
} = {}) {
  const bridgeConfig = resolveWechatBridgeConfig(config, { dataDir });
  const accountId = outboundMessage.accountId;
  if (!accountId) {
    throw new CrewlineError({
      code: ErrorCodes.CHANNEL_SEND_FAILED,
      layer: 'channel',
      recoverable: true,
      message: 'WeChat outbound message requires accountId'
    });
  }
  const account = loadWechatAccount({ bridgeConfig, accountId });
  if (!account?.token) {
    throw new CrewlineError({
      code: ErrorCodes.CHANNEL_SEND_FAILED,
      layer: 'channel',
      recoverable: true,
      message: `WeChat account is not logged in: ${accountId}`
    });
  }
  assertWechatSessionActive(accountId);
  const to = outboundMessage.conversationRef?.participantId ?? outboundMessage.conversationRef?.conversationId;
  if (!to) {
    throw new CrewlineError({
      code: ErrorCodes.CHANNEL_SEND_FAILED,
      layer: 'channel',
      recoverable: true,
      message: 'Missing WeChat recipient'
    });
  }
  const contextToken = getContextToken({
    bridgeConfig,
    accountId,
    userId: to
  });
  const api = createWechatApi({ account, bridgeConfig, fetchImpl });
  const mediaPath = outboundMessage.meta?.wechat?.mediaPath ?? outboundMessage.meta?.wechat?.mediaUrl ?? outboundMessage.meta?.mediaPath ?? outboundMessage.meta?.mediaUrl;
  if (mediaPath) {
    return await sendWechatMediaFile({
      api,
      cdnBaseUrl: account.cdnBaseUrl ?? bridgeConfig.cdnBaseUrl,
      to,
      text: outboundMessage.text ?? '',
      contextToken,
      filePath: mediaPath,
      allowRemoteUrl: config.allowRemoteMediaUrl === true,
      fetchImpl
    });
  }
  const clientId = `crewline-wechat-${crypto.randomUUID()}`;
  await apiPostFetch({
    baseUrl: account.baseUrl ?? bridgeConfig.apiBaseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 1,
          text_item: {
            text: outboundMessage.text ?? ''
          }
        }],
        context_token: contextToken
      },
      base_info: buildBaseInfo()
    }),
    token: account.token,
    timeoutMs: 15_000,
    label: 'sendMessage',
    fetchImpl
  });
  return {
    ok: true,
    messageId: clientId,
    target: to
  };
}

export async function getWechatTypingConfig({
  config = {},
  dataDir,
  accountId,
  userId,
  contextToken,
  fetchImpl = fetch
} = {}) {
  const bridgeConfig = resolveWechatBridgeConfig(config, { dataDir });
  const account = loadWechatAccount({ bridgeConfig, accountId });
  if (!account?.token) return { typingTicket: '' };
  assertWechatSessionActive(accountId);
  const api = createWechatApi({ account, bridgeConfig, fetchImpl });
  const response = await api.getConfig({
    ilinkUserId: userId,
    contextToken
  });
  return {
    typingTicket: response?.typing_ticket ?? ''
  };
}

export async function sendWechatTyping({
  config = {},
  dataDir,
  accountId,
  userId,
  typingTicket,
  status = 1,
  fetchImpl = fetch
} = {}) {
  const bridgeConfig = resolveWechatBridgeConfig(config, { dataDir });
  const account = loadWechatAccount({ bridgeConfig, accountId });
  if (!account?.token || !typingTicket) return false;
  assertWechatSessionActive(accountId);
  const api = createWechatApi({ account, bridgeConfig, fetchImpl });
  await api.sendTyping({
    ilinkUserId: userId,
    typingTicket,
    status
  });
  return true;
}

export async function probeWechatChannel({
  config = {},
  dataDir
} = {}) {
  const bridgeConfig = resolveWechatBridgeConfig(config, { dataDir });
  const accounts = listWechatAccounts({ bridgeConfig });
  return {
    ok: accounts.length > 0,
    channel: WECHAT_CHANNEL_ID,
    provider: WECHAT_PROVIDER_ID,
    accountCount: accounts.length,
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      userId: account.userId,
      baseUrl: account.baseUrl,
      savedAt: account.savedAt
    })),
    inboundSupported: true,
    outboundSupported: true,
    reason: accounts.length > 0 ? null : 'No logged-in WeChat accounts. Run `crewline wechat login` first.'
  };
}

export async function pollWechatMessages({
  config = {},
  dataDir,
  account,
  fetchImpl = fetch,
  onMessage,
  logger,
  signal
} = {}) {
  const bridgeConfig = resolveWechatBridgeConfig(config, { dataDir });
  let getUpdatesBuf = loadGetUpdatesBuf({
    bridgeConfig,
    accountId: account.accountId
  });
  let consecutiveFailures = 0;

  while (!signal?.aborted) {
    try {
      const response = await getUpdates({
        baseUrl: account.baseUrl ?? bridgeConfig.apiBaseUrl,
        token: account.token,
        getUpdatesBuf,
        timeoutMs: bridgeConfig.longPollTimeoutMs,
        fetchImpl
      });
      if (response?.get_updates_buf) {
        getUpdatesBuf = response.get_updates_buf;
        saveGetUpdatesBuf({
          bridgeConfig,
          accountId: account.accountId,
          getUpdatesBuf
        });
      }
      if (response?.ret !== undefined && response.ret !== 0) {
        if (response.ret === SESSION_EXPIRED_ERRCODE || response.errcode === SESSION_EXPIRED_ERRCODE) {
          pauseWechatSession(account.accountId);
          await sleep(getRemainingWechatPauseMs(account.accountId));
          continue;
        }
        throw createWechatError('WeChat getUpdates returned non-zero ret', undefined, response);
      }
      consecutiveFailures = 0;
      for (const message of response?.msgs ?? []) {
        await onMessage?.({ accountId: account.accountId, message, bridgeConfig });
      }
    } catch (error) {
      if (signal?.aborted) return;
      consecutiveFailures += 1;
      logger?.warn?.(`[wechat.poll:${account.accountId}] ${error?.message ?? String(error)}`);
      const delayMs = consecutiveFailures >= bridgeConfig.maxConsecutiveFailures
        ? bridgeConfig.pollBackoffDelayMs
        : bridgeConfig.pollRetryDelayMs;
      if (consecutiveFailures >= bridgeConfig.maxConsecutiveFailures) {
        consecutiveFailures = 0;
      }
      await sleep(delayMs);
    }
  }
}
