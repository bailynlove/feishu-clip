// PROTOTYPE — Variant C：底部动作面板。hero 只留紧凑标题编辑；预览占满中段；底部固定动作栏 = 预设下拉（左）+ 主按钮（中）+ ⋮ 溢出菜单（右，复制/存文件/仅本次目标/图片开关/追加正文全部收进去，不再单独占「本次设置」区块）。
(function () {
  const UI = window.PROTO_UI;

  // 预设下拉（向上展开）
  function presetMenu(state, helpers) {
    if (state.openMenu !== 'preset') return '';
    return `<div class="pc-menu pc-menu-preset">${helpers.PRESETS.map((p) => `
      <button class="ps-menu-row" data-action="set-preset" data-id="${p.id}">
        <span class="ps-menu-icon">⚡</span>${p.name}
        <span class="pc-menu-tpl">${p.titleTemplate.replace(/</g, '&lt;')}</span>
        ${p.id === state.presetId ? '<span class="ps-menu-check">✓</span>' : ''}
      </button>`).join('')}</div>`;
  }

  // ⋮ 溢出菜单：备选导出动作 + 本次设置项（目标/图片/追加正文）
  function moreMenu(state, helpers) {
    if (state.openMenu !== 'more') return '';
    return `<div class="pc-menu pc-menu-more">
      ${UI.actionMenuRows(state, helpers)}
      <div class="pc-menu-sep"></div>
      <div class="pc-menu-label">本次设置 · 仅本次生效</div>
      <div class="pc-menu-cell">${UI.targetRow(state)}</div>
      <div class="pc-menu-cell">${UI.switchRow(state)}</div>
      <div class="pc-menu-cell">${UI.appendRow(state)}</div>
    </div>`;
  }

  window.VARIANT_C = {
    name: 'C — 底部动作面板',
    render(state, helpers) {
      const p = helpers.preset();
      const a = helpers.ACTIONS[p.action];
      const disabled = state.scenario === 'offline' && p.action === 'save';
      return `
      <div class="pc-root">
        <div class="pc-hero">
          ${UI.heroTop(state)}
          <div class="pc-hero-row">${UI.titleInput(state)}${UI.triggerBadge(state)}</div>
        </div>
        <div class="pc-preview ps-preview">${helpers.previewHtml()}</div>
        <div class="pc-above">${UI.note(state)}<div class="ps-fine">每次点击创建新文档 · 关闭弹窗不中断保存</div></div>
        <div class="pc-bar">
          ${presetMenu(state, helpers)}
          ${moreMenu(state, helpers)}
          <button class="pc-preset-btn" data-action="toggle-menu" data-menu="preset" title="切换预设">
            <span class="pc-preset-name">${p.name}</span><span class="pc-preset-caret">▴</span>
          </button>
          <button class="pc-main" data-action="run-action" data-id="${p.action}" ${disabled ? 'disabled' : ''}>${a.icon} ${a.label}</button>
          <button class="pc-more" data-action="toggle-menu" data-menu="more" title="更多">⋮</button>
        </div>
        ${UI.mask(state)}
      </div>`;
    },
  };
})();
