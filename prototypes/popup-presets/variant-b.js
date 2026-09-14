// PROTOTYPE — Variant B：预览优先（Obsidian 风）。hero 压缩为一行标题编辑 + 预设 pill；中间是大滚动预览区，上方一条 Properties ⌄ 折叠条收纳「本次设置」；底部目标 chip + split 主按钮。
(function () {
  const UI = window.PROTO_UI;

  window.VARIANT_B = {
    name: 'B — 预览优先',
    render(state, helpers) {
      return `
      <div class="pb-root">
        <div class="pb-hero">
          ${UI.heroTop(state)}
          <div class="pb-hero-row">${UI.titleInput(state)}</div>
          <div class="pb-hero-sub">${state.page.host} · ${helpers.preset().titleTemplate.replace(/</g, '&lt;')}</div>
          ${UI.presetChips(state, helpers)}
        </div>
        <div class="pb-props">
          <button class="pb-props-head" data-action="toggle-settings">
            <span>Properties</span>
            <span class="pb-props-caret">${state.settingsOpen ? '⌃' : '⌄'}</span>
          </button>
          ${state.settingsOpen ? `<div class="pb-props-body">${UI.settingsBody(state)}</div>` : ''}
        </div>
        <div class="pb-preview ps-preview">${helpers.previewHtml()}</div>
        <div class="pb-bottom">
          ${UI.note(state)}
          ${UI.targetRow(state)}
          ${UI.splitButton(state, helpers)}
          <div class="ps-fine">每次点击创建新文档 · 关闭弹窗不中断保存</div>
        </div>
        ${UI.mask(state)}
      </div>`;
    },
  };
})();
