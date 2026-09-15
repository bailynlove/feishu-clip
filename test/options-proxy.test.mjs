import assert from 'node:assert/strict';
import test from 'node:test';
import { createProxySettingsController } from '../src/extension/options-proxy.js';

function rig(send) {
  const input = { value: '' };
  const result = { textContent: '', className: 'ps-note hidden' };
  return { input, result, controller: createProxySettingsController({ input, result, send }) };
}

test('代理设置控制器加载已存端口，并把数字端口或空值保存到 Bridge', async () => {
  const messages = [];
  const { input, result, controller } = rig(async (message) => {
    messages.push(message);
    if (message.type === 'GET_PROXY_SETTINGS') return { proxyPort: 7897 };
    return { proxyPort: message.proxyPort };
  });
  await controller.load();
  assert.equal(input.value, 7897);
  input.value = '8080';
  await controller.save();
  assert.deepEqual(messages.at(-1), { type: 'SAVE_PROXY_SETTINGS', proxyPort: 8080 });
  assert.equal(result.textContent, '已启用 127.0.0.1:8080');
  assert.equal(result.className, 'ps-note ok');
  input.value = ' ';
  await controller.save();
  assert.deepEqual(messages.at(-1), { type: 'SAVE_PROXY_SETTINGS', proxyPort: null });
  assert.equal(result.textContent, '已关闭本地代理');
});

test('代理设置控制器在非法端口和 Bridge 失败时显示错误且不发送非法值', async () => {
  const messages = [];
  const { input, result, controller } = rig(async (message) => { messages.push(message); throw new Error('Bridge 离线'); });
  await controller.load();
  assert.equal(result.textContent, '读取失败：Bridge 离线');
  input.value = '65536';
  await controller.save();
  assert.equal(messages.length, 1, '非法值在浏览器侧拦截，不发保存消息');
  assert.match(result.textContent, /^保存失败：/);
  assert.equal(result.className, 'ps-note err');
});
