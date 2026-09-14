// PROTOTYPE — 共享外壳：逐行照抄真实 src/extension/popup.html 的标记（动态值填 mock），
// 保证原型与线上一致。变体只负责 AI 摘要部分（aiHtml 注入本次设置 fold-body 末尾）。
window.renderChrome = (state, helpers, aiHtml) => `
<body class="popup"><main>
  <header class="hero"><div class="hero-top"><img class="logo" src="../../src/extension/icons/icon-128.png" alt=""><div class="hero-name"><strong>先存飞书</strong><small class="slogan">先进团队，先存飞书</small></div><span id="bridge" class="pill">Bridge 0.1.2 · 飞书已登录</span><button id="settings" class="hero-gear" title="设置" type="button">⚙</button></div><div class="title-wrap"><input id="page-title" class="title-input" type="text" value="[2609.11916] Can Edge-Deployable Vi…" aria-label="文档标题"><button id="title-reset" class="title-reset hidden" type="button" title="重置为预设模板标题">↺</button></div><p id="page-host">arxiv.org</p></header>
  <div class="popup-body">
    <div id="status" class="status hidden"><span id="status-text" class="status-text"></span><button id="status-close" class="status-close" type="button" aria-label="关闭提示">×</button></div>
    <div id="web-panel">
    <div class="presets-row"><div id="presets" class="presets" role="group" aria-label="预设"><button class="preset-chip" type="button">默认</button><button class="preset-chip" type="button">labuladong</button><button class="preset-chip on" type="button">papers</button></div><button id="save-as-preset" class="save-as-preset" type="button" style="visibility:hidden" title="把本次的改动保存为新预设">新建预设</button></div>
    <span id="trigger-hint" class="trigger-hint hidden">⚡ 已按规则自动选择</span>
    <section class="fold"><button id="settings-toggle" class="fold-head" type="button" data-action="toggle-settings" aria-expanded="${state.settingsOpen}"><span>⚙ 本次设置 <em>仅本次生效</em></span><span id="update-preset" class="update-preset" role="button" tabindex="0" style="visibility:hidden" title="把本次改动写回当前预设">修改预设</span><span id="settings-caret" class="fold-caret">${state.settingsOpen ? '收起 ⌃' : '⌄'}</span></button><div id="settings-body" class="fold-body ${state.settingsOpen ? '' : 'hidden'}">
      <button id="change" class="chip" type="button" title="仅本次更改，不影响默认目标"><span class="chip-icon">🗂</span><span id="destination" class="chip-text">Area（Papers Collection）</span><span id="destination-temp-badge" class="chip-temp hidden">仅本次</span><span class="chip-edit">更改 ›</span></button>
      <label class="img-row"><span class="img-text"><strong>包含图片</strong><small>失败时正文仍会保存</small></span><input id="images" type="checkbox" checked><span class="switch"></span></label>
      <label id="pdf-row" class="img-row"><span class="img-text"><strong>PDF 存云盘</strong><small id="pdf-sub">2609.11916.pdf · 314 KB</small><span id="pdf-temp-badge" class="chip-temp hidden">仅本次</span></span><input id="pdf" type="checkbox" checked><span class="switch"></span></label>
      <button id="pdf-folder" class="chip" type="button" title="仅本次更改，不影响预设目录"><span class="chip-icon">🗂</span><span id="pdf-folder-name" class="chip-text">papers</span><span id="pdf-folder-temp-badge" class="chip-temp hidden">仅本次</span><span class="chip-edit">更改 ›</span></button>
      <textarea id="custom-body" class="custom-body" rows="3" placeholder="自定义正文（仅本次）：{{content}} 表示剪藏正文，可放在前后或环绕；留空则只保存正文" aria-label="自定义正文（仅本次）" spellcheck="false"></textarea>
      ${aiHtml}
    </div></section>
    <section class="fold"><button id="preview-toggle" class="fold-head" type="button" aria-expanded="false"><span>📄 预览 · <span id="preview-title">[2609.11916] Can Edge-Deployable Vi…</span></span><span id="preview-caret" class="fold-caret">展开 ⌄</span></button><div id="preview-body" class="preview-scroll hidden"></div></section>
    <div class="cta"><div class="split"><button id="save" class="primary split-main" type="button">⬇ 保存到飞书</button><button id="action-menu-toggle" class="split-arrow" type="button" title="更多动作" aria-haspopup="menu" aria-expanded="false">▾</button></div></div>
    <small class="fine">每次点击都会创建一篇新文档。关闭弹窗不会中断保存。</small>
    </div>
  </div>
</main></body>`;

// 变体共用片段：临时指令输入框（占位文案含 {{@file}} 提示，与设置页口径一致）
window.renderDigestInstruction = (state) => `
  <textarea class="custom-body ai-instruction" data-field="digest-instruction" rows="2"
    placeholder="临时摘要指令（仅本次）：留空用预设/全局指令；写 {{@file}} 可把 PDF 一并发给 AI"
    spellcheck="false">${state.digest.instruction}</textarea>`;

// 「仅本次」徽标（仅 overridden 时出现，与目录/PDF 的 chip-temp 同款）
window.renderTempBadge = (state) =>
  state.digest.overridden ? '<span class="chip-temp">仅本次</span>' : '';
