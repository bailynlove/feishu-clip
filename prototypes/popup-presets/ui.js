// PROTOTYPE — 三版变体共享的 UI 片段：hero 顶栏、标题输入框、预设选择、状态横幅、本次设置内容、split 主按钮。
(function () {
  const { esc } = window.PROTO.helpers;

  function heroTop(state) {
    const pill = state.scenario === 'offline' ? 'Bridge 未运行' : '飞书已登录';
    return `<div class="ps-hero-top">
      <span class="ps-logo">飞</span><span class="ps-hero-name">飞书剪藏</span>
      <span class="ps-pill">${pill}</span>
      <button class="ps-gear" data-action="open-settings" title="设置">⚙</button>
    </div>`;
  }

  // hero 内的可编辑标题：内容 = 当前预设标题模板渲染结果；手动改过可 ↺ 回到模板
  function titleInput(state, cls = '') {
    return `<div class="ps-title-wrap ${cls}">
      <input class="ps-title-input" data-field="title" value="${esc(state.title)}" aria-label="标题" spellcheck="false">
      ${state.titleDirty ? '<button class="ps-title-reset" data-action="reset-title" title="按预设模板重新渲染">↺ 模板</button>' : ''}
    </div>`;
  }

  function triggerBadge(state) {
    return state.viaTrigger ? '<span class="ps-trigger">⚡ 已按规则自动选择</span>' : '';
  }

  // 预设 chip 选择器（横排）
  function presetChips(state, helpers) {
    return `<div class="ps-chips">${helpers.PRESETS.map((p) => `
      <button class="ps-chip-opt ${p.id === state.presetId ? 'on' : ''}" data-action="set-preset" data-id="${p.id}">${p.name}</button>`).join('')}
      ${triggerBadge(state)}
    </div>`;
  }

  function note(state) {
    return state.notice ? `<div class="ps-note ${state.notice.tone}">${state.notice.text}</div>` : '';
  }

  function switchRow(state) {
    return `<button class="ps-switch-row ${state.includeImages ? 'on' : ''}" data-action="toggle-images">
      <span class="ps-switch-text"><span class="ps-switch-label">包含图片</span><span class="ps-switch-sub">失败时正文仍会保存</span></span>
      <span class="ps-switch"></span>
    </button>`;
  }

  function targetRow(state) {
    return `<button class="ps-target" data-action="fake-target" title="仅本次更改保存目标">
      <span class="ps-target-icon">📁</span>
      <span class="ps-target-text">${state.target.path.join(' / ')}</span>
      <span class="ps-target-edit">更改 ›</span>
    </button>`;
  }

  function appendRow(state) {
    return `<input class="ps-append" data-field="append" value="${esc(state.appendNote)}" placeholder="追加正文（仅本次）…" spellcheck="false">`;
  }

  // 「本次设置」折叠区的内容本体（三版共用）
  function settingsBody(state) {
    return `<div class="ps-settings-body">${targetRow(state)}${switchRow(state)}${appendRow(state)}</div>`;
  }

  function actionMenuRows(state, helpers) {
    const cur = helpers.preset().action;
    return Object.entries(helpers.ACTIONS).map(([id, a]) => `
      <button class="ps-menu-row" data-action="run-action" data-id="${id}">
        <span class="ps-menu-icon">${a.icon}</span>${a.label}${id === cur ? '<span class="ps-menu-check">默认 ✓</span>' : ''}
      </button>`).join('');
  }

  // split 主按钮：主动作跟随预设默认动作 + ▾ 下拉三个备选动作
  function splitButton(state, helpers) {
    const cur = helpers.preset().action;
    const a = helpers.ACTIONS[cur];
    const disabled = state.scenario === 'offline' && cur === 'save';
    const menu = state.openMenu === 'split' ? `<div class="ps-menu ps-menu-up">${actionMenuRows(state, helpers)}</div>` : '';
    return `<div class="ps-split">
      ${menu}
      <button class="ps-split-main" data-action="run-action" data-id="${cur}" ${disabled ? 'disabled' : ''}>${a.icon} ${a.label}</button>
      <button class="ps-split-arrow" data-action="toggle-menu" data-menu="split" title="更多动作">▾</button>
    </div>`;
  }

  function mask(state) {
    return state.openMenu ? '<div class="ps-mask" data-action="close-menus"></div>' : '';
  }

  window.PROTO_UI = { heroTop, titleInput, triggerBadge, presetChips, note, switchRow, targetRow, appendRow, settingsBody, actionMenuRows, splitButton, mask };
})();
