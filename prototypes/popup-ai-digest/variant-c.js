// PROTOTYPE — 变体 C「跟随预设 + 覆盖条」：默认只有一行状态条「跟随预设（开 · deepseek）」，
// 点「本次调整 ›」才进入覆盖模式展开开关/provider/指令；覆盖后常驻「仅本次」徽标 + 「恢复跟随」。
// 把「跟随 vs 覆盖」心智显式化——其他字段（目录/图片）其实也是这语义，但都没说破。
window.VARIANT_C = {
  name: 'C — 跟随预设 + 覆盖条',
  render(state, helpers) {
    const d = state.digest;
    const providers = helpers.providers();
    const aiHtml = d.overridden
      ? `
      <div class="ai-override">
        <div class="ai-override-head">
          <strong>AI 摘要</strong><span class="chip-temp">仅本次</span>
          <button class="ai-revert" type="button" data-action="reset-digest">恢复跟随预设</button>
        </div>
        <label class="img-row">
          <span class="img-text"><strong>本次生成摘要</strong></span>
          <input type="checkbox" data-field="digest-on" ${d.on ? 'checked' : ''}><span class="switch"></span>
        </label>
        ${d.on ? `
          ${providers.length === 0
            ? '<p class="ai-empty">未配置 AI provider，请到设置页「AI 摘要」区添加</p>'
            : `<select class="ai-select" data-field="digest-provider" aria-label="AI provider（仅本次）">
                ${providers.map((p) => `<option ${p === d.provider ? 'selected' : ''}>${p}</option>`).join('')}
              </select>`}
          ${window.renderDigestInstruction(state)}
        ` : ''}
      </div>`
      : `
      <button class="chip ai-follow" type="button" data-action="toggle-digest-override">
        <span class="chip-icon">✨</span>
        <span class="chip-text">AI 摘要：跟随预设（${helpers.followSummary()}）</span>
        <span class="chip-edit">本次调整 ›</span>
      </button>`;
    return window.renderChrome(state, helpers, aiHtml);
  },
};
