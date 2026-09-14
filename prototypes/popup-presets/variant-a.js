// PROTOTYPE — Variant A：单栏流式。现状弹窗的自然延伸：hero（可编辑标题）→ 预设 chip → 半高预览卡片（默认折叠成摘要条）→「本次设置」折叠区 → 底部 split 主按钮。改动最小、信息层级与现状一致。
(function () {
  const UI = window.PROTO_UI;

  function previewCard(state, helpers) {
    if (!state.previewOpen) {
      return `<button class="pa-pv-bar" data-action="toggle-preview">
        <span class="pa-pv-bar-icon">📄</span>
        <span class="pa-pv-bar-text">预览 · ${helpers.esc(state.title)}</span>
        <span class="pa-pv-bar-caret">展开 ⌄</span>
      </button>`;
    }
    return `<div class="pa-pv-card">
      <button class="pa-pv-bar open" data-action="toggle-preview">
        <span class="pa-pv-bar-icon">📄</span>
        <span class="pa-pv-bar-text">正文预览</span>
        <span class="pa-pv-bar-caret">收起 ⌃</span>
      </button>
      <div class="pa-pv-scroll ps-preview">${helpers.previewHtml()}</div>
    </div>`;
  }

  window.VARIANT_A = {
    name: 'A — 单栏流式',
    render(state, helpers) {
      return `
      <div class="pa-root">
        <div class="pa-hero">
          ${UI.heroTop(state)}
          <div class="pa-hero-title">${UI.titleInput(state)}</div>
          <div class="pa-hero-host">${state.page.host}</div>
        </div>
        <div class="pa-body">
          ${UI.presetChips(state, helpers)}
          <div class="pa-settings">
            <button class="pa-settings-head" data-action="toggle-settings">
              <span>⚙ 本次设置 <em>仅本次生效</em></span>
              <span class="pa-settings-caret">${state.settingsOpen ? '⌃' : '⌄'}</span>
            </button>
            ${state.settingsOpen ? UI.settingsBody(state) : ''}
          </div>
          ${previewCard(state, helpers)}
          ${UI.note(state)}
          <div class="pa-cta">${UI.splitButton(state, helpers)}</div>
          <div class="ps-fine">每次点击创建新文档 · 关闭弹窗不中断保存</div>
        </div>
        ${UI.mask(state)}
      </div>`;
    },
  };
})();
