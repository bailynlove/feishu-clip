// PROTOTYPE — 变体 A「内联开关行」：与「包含图片 / PDF 存云盘」同款的开关行，
// 打开后行下方内联展开 provider 下拉 + 临时指令框。改动最小、最贴现状。
window.VARIANT_A = {
  name: 'A — 内联开关行',
  render(state, helpers) {
    const d = state.digest;
    const providers = helpers.providers();
    const sub = d.overridden
      ? `本次：${d.on ? `开 · ${d.provider}` : '关'}`
      : `跟随预设：${helpers.followSummary()}`;
    const aiHtml = `
      <div class="ai-block">
        <label class="img-row">
          <span class="img-text"><strong>AI 摘要</strong><small>${sub}</small>${window.renderTempBadge(state)}</span>
          <input type="checkbox" data-field="digest-on" ${d.on ? 'checked' : ''}><span class="switch"></span>
        </label>
        ${d.on ? `
          <div class="ai-inline">
            ${providers.length === 0
              ? '<p class="ai-empty">未配置 AI provider，请到设置页「AI 摘要」区添加</p>'
              : `<select class="ai-select" data-field="digest-provider" aria-label="AI provider（仅本次）">
                  ${providers.map((p) => `<option ${p === d.provider ? 'selected' : ''}>${p}</option>`).join('')}
                </select>`}
            ${window.renderDigestInstruction(state)}
          </div>` : ''}
      </div>`;
    return window.renderChrome(state, helpers, aiHtml);
  },
};
