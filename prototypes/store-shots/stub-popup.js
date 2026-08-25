// 商店截图用 chrome.* 最小桩（popup）：真实 popup.js 直接跑在这份假数据上。
// 由 build.mjs 内联进生成的 HTML，在模块脚本之前执行。
(() => {
  const TAB = {
    url: 'https://labuladong.online/algo/intro/quick-start-plan/',
    title: '算法：速成目录学习规划',
  };
  const SNAPSHOT = {
    title: TAB.title,
    sourceUrl: TAB.url,
    capturedAt: '2026-08-25T09:30:00.000Z',
    markdown: [
      '# 算法：速成目录学习规划',
      '',
      '零基础怎么学算法？这份目录按阶段执行即可。',
      '',
      '## 第一阶段：数据结构基础',
      '',
      '- 数组、链表、栈与队列',
      '- 二叉树与递归思维',
      '',
      '![学习路线图](roadmap.png)',
      '',
      '## 第二阶段：核心算法思想',
      '',
      '双指针、滑动窗口、二分搜索最高频，务必优先掌握。',
      '',
      '## 第三阶段：动态规划',
      '',
      '动态规划是硬骨头，配合「状态转移方程」专题反复练习。',
    ].join('\n'),
  };
  const SETTINGS = {
    defaultPresetId: 'p-default',
    activeAttempt: null,
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
      openOptionsPage() {},
      sendMessage(payload) {
        switch (payload?.type) {
          case 'GET_SETTINGS': return respond(SETTINGS);
          case 'STATUS': return respond({ version: '0.1.0', larkAuth: { ready: true } });
          case 'EXTRACT': return respond(SNAPSHOT);
          default: return respond(null);
        }
      },
    },
    tabs: {
      query: () => Promise.resolve([TAB]),
      create: () => Promise.resolve(),
    },
    downloads: { download: () => Promise.resolve(1) },
  };
})();
