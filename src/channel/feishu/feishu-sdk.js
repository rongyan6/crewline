import axios from 'axios';
import * as Lark from '@larksuiteoapi/node-sdk';

const FEISHU_NO_PROXY_HOSTS = [
  'open.feishu.cn',
  'ws-open.feishu.cn',
  'open.larksuite.com',
  'ws-open.larksuite.com',
  'open.larkoffice.com',
  'ws-open.larkoffice.com'
];

function installFeishuHttpInterceptors(httpInstance) {
  httpInstance.interceptors.request.use((req) => {
    if (req.headers) {
      req.headers['User-Agent'] = 'oapi-node-sdk/1.0.0';
    }
    return req;
  }, undefined, { synchronous: true });
  httpInstance.interceptors.response.use((resp) => {
    if (resp.config?.$return_headers) {
      return {
        data: resp.data,
        headers: resp.headers
      };
    }
    return resp.data;
  });
  return httpInstance;
}

const defaultFeishuHttpInstance = installFeishuHttpInterceptors(axios.create());

export function ensureFeishuNoProxy(hosts = FEISHU_NO_PROXY_HOSTS) {
  const current = process.env.NO_PROXY || process.env.no_proxy || '';
  const entries = new Set(
    current
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  for (const host of hosts) entries.add(host);
  const next = Array.from(entries).join(',');
  process.env.NO_PROXY = next;
  process.env.no_proxy = next;
  return next;
}

export function resolveFeishuNetworkConfig(network = {}) {
  return {
    useSystemProxy: network?.useSystemProxy === true
  };
}

export function createFeishuHttpInstance(network = {}) {
  const resolved = resolveFeishuNetworkConfig(network);
  if (resolved.useSystemProxy) {
    ensureFeishuNoProxy();
    return defaultFeishuHttpInstance;
  }
  return installFeishuHttpInterceptors(axios.create({ proxy: false }));
}

export function createFeishuSdkClient({ appId, appSecret, network } = {}) {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    httpInstance: createFeishuHttpInstance(network)
  });
}

export function createFeishuEventDispatcher({ encryptKey = '', verificationToken = '' } = {}) {
  return new Lark.EventDispatcher({
    encryptKey,
    verificationToken
  });
}

export function createFeishuWsClient({ appId, appSecret, network } = {}) {
  return new Lark.WSClient({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
    httpInstance: createFeishuHttpInstance(network)
  });
}
