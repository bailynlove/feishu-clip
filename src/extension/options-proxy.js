import { normalizeProxyPortInput } from './options-state.js';

export function createProxySettingsController({ input, result, send }) {
  const show = (text, tone) => {
    result.textContent = text;
    result.className = `ps-note ${tone}`;
  };
  return {
    async load() {
      try {
        const settings = await send({ type: 'GET_PROXY_SETTINGS' });
        input.value = settings.proxyPort ?? '';
      } catch (error) {
        show(`读取失败：${error.message}`, 'err');
      }
    },
    async save() {
      try {
        const proxyPort = normalizeProxyPortInput(input.value);
        const saved = await send({ type: 'SAVE_PROXY_SETTINGS', proxyPort });
        input.value = saved.proxyPort ?? '';
        show(saved.proxyPort ? `已启用 127.0.0.1:${saved.proxyPort}` : '已关闭本地代理', 'ok');
      } catch (error) {
        show(`保存失败：${error.message}`, 'err');
      }
    },
  };
}
