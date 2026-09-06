// PROTOTYPE — 变体 A：单进度·阶段串联。布局与现行弹窗几乎一致；PDF 能力收在「本次设置」折叠区里，
// 状态区只有一条进度/一条结论，双 job 以阶段文案轮替呈现。改动面最小的路线。
(function () {
  function pdfRow(s, ui) {
    if (!s.detected) return '';
    if (!s.presetPdf && !s.pdfOn) {
      // 发现性收起态：预设没开，给一次性入口
      return `<button class="va-discover" data-action="enable-pdf">📕 本页包含 PDF（${s.pdf.sizeMB} MB）—— 本次顺带存入云盘 ›</button>`;
    }
    return `
      <div class="va-pdfrow">
        <div class="ps-switch-row ${s.pdfOn ? 'on' : ''}" data-action="toggle-pdf" role="button" tabindex="0">
          <span class="ps-switch-text">
            <span class="ps-switch-label">PDF 存云盘</span>
            <span class="ps-switch-sub">${ui.esc(s.pdf.name)} · ${s.pdf.sizeMB} MB${s.presetPdf ? '' : ' · 仅本次'}</span>
          </span>
          <span class="ps-switch"></span>
        </div>
        ${s.pdfOn ? `<button class="ps-target" data-action="cycle-folder"><span class="ps-target-text">🗂 ${ui.esc(s.folder)}</span><span class="ps-target-edit">更改 ›</span></button>` : ''}
      </div>`;
  }

  function statusNote(s, ui) {
    const { clipPart, pdfPart } = ui.jobText(s);
    if (s.clip.status === 'running' || s.pdfJob.status === 'running') {
      return `
        <div class="ps-note info va-status">
          <div style="flex:1">
            <div>${clipPart} · ${pdfPart}</div>
            <div class="ps-progress" style="margin-top:6px"><i style="width:${Math.max(s.clip.pct, s.pdfJob.pct)}%"></i></div>
          </div>
        </div>`;
    }
    if (s.clip.status === 'done' && s.pdfJob.status === 'done') {
      return `
        <div class="ps-note ok">已保存 ✓ 文档与 PDF 均已入库</div>
        <div class="va-links">
          <button class="va-link" data-action="alert">打开飞书文档 ↗</button>
          <button class="va-link" data-action="alert">打开云盘 PDF ↗</button>
        </div>`;
    }
    if (s.pdfJob.status === 'failed') {
      return `
        <div class="ps-note warn">文档已保存 ✓，但 PDF 上传失败（网络错误）。文档不受影响。</div>
        <div class="va-links">
          <button class="va-link" data-action="alert">打开飞书文档 ↗</button>
          <button class="va-link warn" data-action="retry-pdf">重试 PDF 上传</button>
        </div>`;
    }
    if (s.clip.status === 'failed') {
      return `
        <div class="ps-note err">文档创建失败（Bridge 超时）；PDF 已存云盘 ✓</div>
        <div class="va-links">
          <button class="va-link warn" data-action="retry-clip">重试文档</button>
          <button class="va-link" data-action="alert">打开云盘 PDF ↗</button>
        </div>`;
    }
    return '';
  }

  function cta(s) {
    if (s.clip.status === 'running' || s.pdfJob.status === 'running') {
      return `<button class="ps-split-main" disabled>保存中…</button>`;
    }
    const label = s.pdfOn && s.detected ? '⬇ 保存到飞书 + PDF' : '⬇ 保存到飞书';
    return `
      <div class="ps-split">
        <button class="ps-split-main" data-action="save">${label}</button>
        <button class="ps-split-arrow" data-action="alert" title="更多动作">▾</button>
      </div>`;
  }

  function pdfTabPanel(s, ui) {
    if (s.pdfJob.status === 'done') {
      return `
        <div class="ps-body">
          <div class="va-pdftab">
            <div class="va-pdficon">📕</div>
            <strong>${ui.esc(s.pdf.name)}</strong>
            <small>${s.pdf.sizeMB} MB → 🗂 ${ui.esc(s.folder)}</small>
          </div>
          <div class="ps-note ok">PDF 已存云盘 ✓（此页是 PDF，未创建剪藏文档）</div>
          <button class="ps-split-main" data-action="alert">打开云盘 PDF ↗</button>
        </div>`;
    }
    if (s.pdfJob.status === 'running') {
      return `
        <div class="ps-body">
          <div class="va-pdftab">
            <div class="va-pdficon">📕</div>
            <strong>${ui.esc(s.pdf.name)}</strong>
            <small>${s.pdf.sizeMB} MB → 🗂 ${ui.esc(s.folder)}</small>
          </div>
          <div class="ps-progress"><i style="width:${s.pdfJob.pct}%"></i></div>
          <button class="ps-split-main" disabled>上传中 ${s.pdfJob.pct}%…</button>
          <small class="ps-fine">此页是 PDF：仅上传云盘，不创建剪藏文档</small>
        </div>`;
    }
    return `
      <div class="ps-body">
        <div class="va-pdftab">
          <div class="va-pdficon">📕</div>
          <strong>${ui.esc(s.pdf.name)}</strong>
          <small>${s.pdf.sizeMB} MB</small>
        </div>
        <button class="ps-target" data-action="cycle-folder"><span class="ps-target-text">🗂 ${ui.esc(s.folder)}</span><span class="ps-target-edit">更改 ›</span></button>
        <button class="ps-split-main" data-action="save">⬇ 保存 PDF 到云盘</button>
        <small class="ps-fine">此页是 PDF：仅上传云盘，不创建剪藏文档</small>
      </div>`;
  }

  window.VARIANT_A = {
    name: 'A — 单进度·阶段串联',
    render(s, ui) {
      if (s.pdfTab) return ui.hero(s) + pdfTabPanel(s, ui);
      return `
        ${ui.hero(s)}
        <div class="ps-body">
          ${ui.presetsRow()}
          ${statusNote(s, ui)}
          <section class="va-fold">
            <button class="va-fold-head" data-action="toggle-settings"><span>⚙ 本次设置 <em>仅本次生效</em></span><span>${s.settingsOpen ? '⌃' : '⌄'}</span></button>
            ${s.settingsOpen ? `<div class="va-fold-body">
              <button class="ps-target" data-action="alert"><span class="ps-target-text">🗂 Resource / 剪藏待读</span><span class="ps-target-edit">更改 ›</span></button>
              <div class="ps-switch-row on" data-action="alert" role="button" tabindex="0"><span class="ps-switch-text"><span class="ps-switch-label">包含图片</span><span class="ps-switch-sub">失败时正文仍会保存</span></span><span class="ps-switch"></span></div>
              ${pdfRow(s, ui)}
            </div>` : ''}
          </section>
          ${!s.settingsOpen ? pdfRow(s, ui) : ''}
          ${cta(s)}
          <small class="ps-fine">每次点击都会创建一篇新文档。关闭弹窗不会中断保存。</small>
        </div>`;
    },
  };
})();
