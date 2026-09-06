// PROTOTYPE — 共享渲染件：hero、预设 chips、状态文案。变体各自决定布局，只共用这些"外壳"。
(function () {
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hero(state) {
    const title = state.pdfTab ? state.pdf.name : state.page.title;
    return `
      <header class="ps-hero">
        <div class="ps-hero-top">
          <span class="ps-logo">先</span>
          <span class="ps-hero-name">先存飞书</span>
          <span class="ps-pill">Bridge 已连接</span>
          <button class="ps-gear" data-action="alert" title="设置">⚙</button>
        </div>
        <div class="ps-title-wrap">
          <input class="ps-title-input" type="text" value="${esc(title)}" aria-label="文档标题">
        </div>
        <small class="ps-host">${esc(state.page.host)} · ${state.pdfTab ? 'application/pdf' : 'HTML 页面'}</small>
      </header>`;
  }

  function presetsRow() {
    return `
      <div class="ps-chips" style="padding:0 2px">
        <button class="ps-chip-opt" data-action="alert">默认</button>
        <button class="ps-chip-opt on" data-action="alert">Paper</button>
        <button class="ps-chip-opt" data-action="alert">Intern</button>
        <span class="ps-trigger">⚡ arxiv.org 规则命中</span>
      </div>`;
  }

  function jobText(state) {
    const c = state.clip.status, p = state.pdfJob.status;
    const mb = ((state.pdfJob.pct / 100) * state.pdf.sizeMB).toFixed(1);
    const pdfPart = p === 'done' ? 'PDF ✓'
      : p === 'failed' ? 'PDF 上传失败'
      : p === 'running' ? `PDF 上传中 ${mb}/${state.pdf.sizeMB} MB`
      : 'PDF 待上传';
    const clipPart = c === 'done' ? '文档 ✓'
      : c === 'failed' ? '文档创建失败'
      : c === 'running' ? `文档 ${state.clip.pct}%`
      : '文档待保存';
    return { clipPart, pdfPart, mb };
  }

  window.UI = { esc, hero, presetsRow, jobText };
})();
