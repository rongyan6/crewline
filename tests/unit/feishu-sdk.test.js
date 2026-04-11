import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuHttpInstance, ensureFeishuNoProxy } from '../../src/channel/feishu/feishu-sdk.js';

test('ensureFeishuNoProxy appends Feishu domains to NO_PROXY', () => {
  const previousNoProxy = process.env.NO_PROXY;
  const previousLower = process.env.no_proxy;
  try {
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    delete process.env.no_proxy;
    const result = ensureFeishuNoProxy();
    assert.match(result, /localhost/);
    assert.match(result, /open\.feishu\.cn/);
    assert.match(result, /ws-open\.feishu\.cn/);
    assert.match(result, /open\.larksuite\.com/);
    assert.equal(process.env.no_proxy, process.env.NO_PROXY);
  } finally {
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    if (previousLower === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = previousLower;
  }
});

test('createFeishuHttpInstance can disable system proxy lookup', () => {
  const httpInstance = createFeishuHttpInstance({ useSystemProxy: false });
  assert.equal(httpInstance.defaults.proxy, false);
});
