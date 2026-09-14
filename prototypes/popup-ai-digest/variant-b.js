// PROTOTYPE — 变体 B（v2）「开关即折叠」：子卡头部是一行开关——开 = 摘要开 + 展开
// provider 分段选择 + 临时指令；关 = 摘要关 + 折叠。默认跟随预设（改动后副标题变「本次：…」），
// 无「仅本次」徽标。
window.VARIANT_B = {
  name: 'B — 开关即折叠',
  render(state, helpers) {
    const d = state.digest;
    const providers = helpers.providers();
    const sub = d.overridden
      ? `本次：${d.on ? `开 · ${d.provider}` : '关'}`
      : `跟随预设：${helpers.followSummary()}`;
    const aiHtml = `
      <section class="fold ai-fold">
        <label class="ai-fold-head">
          <span class="img-text"><strong>✨ AI 摘要</strong><small>${sub}</small></span>
          <input type="checkbox" data-field="digest-on" ${d.on ? 'checked' : ''}><span class="switch"></span>
        </label>
        <div class="fold-body ${d.on ? '' : 'hidden'}">
          ${providers.length === 0
            ? '<p class="ai-empty">未配置 AI provider，请到设置页「AI 摘要」区添加</p>'
            : `<div class="ai-seg" role="group" aria-label="AI provider（仅本次）">
                ${providers.map((p) => `<button class="ai-seg-opt ${p === d.provider ? 'on' : ''}" type="button" data-action="set-provider" data-id="${p}">${p}</button>`).join('')}
              </div>`}
          ${window.renderDigestInstruction(state)}
        </div>
      </section>`;
    return window.renderChrome(state, helpers, aiHtml);
  },
};
