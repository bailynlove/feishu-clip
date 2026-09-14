// PROTOTYPE — 预设体系模拟状态与假数据。三版变体共用：预设切换、标题模板重渲、trigger 命中提示、三种导出动作反馈。
(function () {
  const FIXED_NOW = new Date(2026, 7, 21); // 固定日期，截图可复现
  const pad = (n) => String(n).padStart(2, '0');

  const PRESETS = [
    { id: 'default', name: '默认', titleTemplate: '{{title}}', bodyLead: '', action: 'save' },
    { id: 'paper', name: 'Paper', titleTemplate: '[论文] {{title}}', bodyLead: '📄 论文剪藏 · 来源 {{host}} · {{date|date:YYYY-MM-DD}}', action: 'file' },
    { id: 'intern', name: 'Intern', titleTemplate: '{{date|date:YYYYMMDD}} {{title}}', bodyLead: 'created: {{date|date:YYYY-MM-DD}}\nsource: {{url}}', action: 'copy' },
  ];
  const ACTIONS = {
    save: { icon: '⬇', label: '保存到飞书', done: '已保存到飞书 ✓' },
    copy: { icon: '⧉', label: '复制到剪贴板', done: '已复制到剪贴板 ✓' },
    file: { icon: '💾', label: '保存为文件', done: '已保存为文件 · Downloads/20260821-attention.md ✓' },
  };

  const state = {
    scenario: 'ready', // ready | trigger | copied | filed | offline
    presetId: 'default',
    viaTrigger: false,
    title: '',
    titleDirty: false, // 手动改过标题后不再随模板重渲
    settingsOpen: false, // 可折叠「本次设置」
    previewOpen: false, // 仅变体 A：预览默认折叠成摘要条
    includeImages: true,
    appendNote: '',
    openMenu: null, // 'split' | 'preset' | 'more'
    notice: null, // { text, tone: 'info'|'ok'|'warn'|'err' }
    wantFocus: null, // 重渲后恢复焦点：'title' | 'append'
    page: {
      title: 'Attention Is All You Need',
      host: 'arxiv.org',
      url: 'https://arxiv.org/abs/1706.03762',
    },
    target: { path: ['Resource', '剪藏待读'] },
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function preset() { return PRESETS.find((p) => p.id === state.presetId); }

  function renderTemplate(tpl) {
    const map = {
      '{{title}}': state.page.title,
      '{{host}}': state.page.host,
      '{{url}}': state.page.url,
      '{{date|date:YYYYMMDD}}': `${FIXED_NOW.getFullYear()}${pad(FIXED_NOW.getMonth() + 1)}${pad(FIXED_NOW.getDate())}`,
      '{{date|date:YYYY-MM-DD}}': `${FIXED_NOW.getFullYear()}-${pad(FIXED_NOW.getMonth() + 1)}-${pad(FIXED_NOW.getDate())}`,
    };
    return tpl.replace(/\{\{[^}]+\}\}/g, (m) => (m in map ? map[m] : m));
  }

  function renderTitle() { return renderTemplate(preset().titleTemplate); }

  // 预览合成：预设正文模板（bodyLead）→ 剪藏正文 → 本次追加正文
  function previewHtml() {
    const lead = renderTemplate(preset().bodyLead);
    const leadHtml = lead ? `<blockquote class="pv-lead">${esc(lead).replace(/\n/g, '<br>')}</blockquote>` : '';
    const img = state.includeImages
      ? '<figure class="pv-img"><div class="pv-img-box">🖼</div><figcaption>figure-1.png · Transformer 架构图</figcaption></figure>'
      : '<div class="pv-img-skip">🖼 图片已跳过（本次不含图片）</div>';
    const note = state.appendNote.trim() ? `<blockquote class="pv-note">📝 ${esc(state.appendNote.trim())}</blockquote>` : '';
    return `
      <h1>${esc(state.title)}</h1>
      ${leadHtml}
      <p>我们提出 Transformer，一种完全基于注意力机制的序列转导模型，摒弃了循环与卷积结构。在两项机器翻译任务上，该模型以质量更优、并行度更高、训练时间显著更少而胜出。</p>
      <h2>1 引言</h2>
      <p>循环神经网络（RNN）、尤其是 LSTM 与 GRU，已被确立为序列建模与转导问题上的最先进方法……</p>
      ${img}
      <h2>3 模型架构</h2>
      <ul>
        <li>编码器由 6 个相同层堆叠而成</li>
        <li>每层包含多头自注意力与前馈网络两个子层</li>
        <li>每个子层外接残差连接 + LayerNorm</li>
      </ul>
      <p>在 WMT 2014 英德翻译任务上取得 28.4 BLEU，比现有最佳结果（含集成模型）提升 2.0 BLEU 以上。</p>
      ${note}`;
  }

  const listeners = new Set();
  function emit() { listeners.forEach((fn) => fn(state)); }

  const actions = {
    setPreset(id, opts = {}) {
      state.presetId = id;
      state.viaTrigger = !!opts.viaTrigger;
      if (!state.titleDirty) state.title = renderTitle();
      state.openMenu = null;
      emit();
    },
    editTitle(value) { state.title = value; state.titleDirty = true; state.wantFocus = 'title'; emit(); },
    resetTitle() { state.titleDirty = false; state.title = renderTitle(); emit(); },
    editAppend(value) { state.appendNote = value; state.wantFocus = 'append'; emit(); },
    toggleSettings() { state.settingsOpen = !state.settingsOpen; emit(); },
    togglePreview() { state.previewOpen = !state.previewOpen; emit(); },
    toggleImages() { state.includeImages = !state.includeImages; emit(); },
    toggleMenu(name) { state.openMenu = state.openMenu === name ? null : name; emit(); },
    closeMenus() { if (state.openMenu) { state.openMenu = null; emit(); } },
    fakeTarget() { state.openMenu = null; state.notice = { text: '原型：这里会打开目标选择器（仅本次）', tone: 'info' }; emit(); },
    runAction(kind) {
      state.openMenu = null;
      if (kind === 'save' && state.scenario === 'offline') { emit(); return; }
      state.notice = { text: ACTIONS[kind].done, tone: 'ok' };
      emit();
    },
    setScenario(name) {
      state.scenario = name;
      state.openMenu = null;
      state.viaTrigger = false;
      if (name === 'ready') {
        state.presetId = 'default';
        if (!state.titleDirty) state.title = renderTitle();
        state.notice = null;
      }
      if (name === 'trigger') {
        // 演示：URL 规则命中 arxiv.org → 自动选择 Paper 预设
        state.presetId = 'paper';
        state.viaTrigger = true;
        if (!state.titleDirty) state.title = renderTitle();
        state.notice = { text: '⚡ 命中规则 arxiv.org/* → 已按规则自动选择「Paper」预设', tone: 'info' };
      }
      if (name === 'copied') state.notice = { text: ACTIONS.copy.done, tone: 'ok' };
      if (name === 'filed') state.notice = { text: ACTIONS.file.done, tone: 'ok' };
      if (name === 'offline') state.notice = { text: '本地 Bridge 未运行，无法保存到飞书', tone: 'err' };
      emit();
    },
  };

  state.title = renderTitle();

  window.PROTO = {
    state,
    actions,
    helpers: { PRESETS, ACTIONS, preset, renderTitle, previewHtml, esc },
    onChange: (fn) => listeners.add(fn),
  };
})();
