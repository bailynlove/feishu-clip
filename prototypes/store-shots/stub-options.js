// 商店截图用 chrome.* 最小桩（options）：与 stub-popup.js 同一套预设数据。
(() => {
  const SETTINGS = {
    defaultPresetId: 'p-default',
    presets: [
      {
        id: 'p-default',
        name: '默认',
        destination: { kind: 'node', nodeToken: 'wikcnStoreShot01', spaceId: '76123456789', title: '读书笔记', path: ['知识库', '技术'] },
        includeImages: true,
        titleTemplate: '{{title}}',
        bodyTemplate: '> 来源：{{url}}\n> 剪藏于 {{datetime}}',
        action: 'feishu',
        triggers: [],
      },
      {
        id: 'p-labuladong',
        name: 'labuladong',
        destination: { kind: 'space', spaceId: '76123456789', title: '算法笔记' },
        includeImages: true,
        titleTemplate: '{{title}}',
        bodyTemplate: '',
        action: 'feishu',
        triggers: ['https://labuladong.online'],
      },
    ],
  };
  const respond = (result) => Promise.resolve({ ok: true, result });
  window.chrome = {
    runtime: {
      id: 'akjgjfpdopmndgacnmclhbodfmkhgnlp',
      sendMessage(payload) {
        switch (payload?.type) {
          case 'GET_SETTINGS': return respond(SETTINGS);
          case 'STATUS': return respond({ version: '0.1.0', larkAuth: { ready: true } });
          default: return respond(null);
        }
      },
    },
  };
})();
