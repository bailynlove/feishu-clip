// PROTOTYPE — 变体 C：主按钮承载一切。检测到 PDF 时是 hero 下的醒目 banner；进度与结果
// 都长在主 CTA 上（按钮本体带进度填充、完成时裂变成产物按钮组）。状态区概念消失。
(function () {
  function banner(s, ui) {
    if (!s.detected) return '';
    if (!s.presetPdf && !s.pdfOn) {
      return `
        <button class="vc-banner collapsed" data-action="enable-pdf">
          <span>📕 本页含 PDF · ${s.pdf.sizeMB} MB</span>
          <span class="vc-banner-act">本次一并存入云盘 ›</span>
        </button>`;
    }
    if (!s.pdfOn) {
      return `
        <div class="vc-banner off">
          <span>📕 ${ui.esc(s.pdf.name)} · ${s.pdf.sizeMB} MB</span>
          <button class="vc-mini" data-action="toggle-pdf">本次开启</button>
        </div>`;
    }
    return `
      <div class="vc-banner">
        <div class="vc-banner-main">
          <span class="vc-banner-title">📕 主 PDF 随剪藏入库</span>
          <small>${ui.esc(s.pdf.name)} · ${s.pdf.sizeMB} MB → 🗂 ${ui.esc(s.folder)}</small>
        </div>
        <button class="vc-mini" data-action="cycle-folder">换目录</button>
        <button class="vc-mini" data-action="toggle-pdf">关闭</button>
      </div>`;
  }

  function cta(s, ui) {
    const { clipPart, pdfPart } = ui.jobText(s);
    const busy = s.clip.status === 'running' || s.pdfJob.status === 'running';
    const pct = s.pdfTab ? s.pdfJob.pct : Math.round((s.clip.pct + (s.pdfOn ? s.pdfJob.pct : 100)) / (s.pdfOn ? 2 : 1));

    if (busy) {
      const sub = s.pdfTab ? `上传中 ${s.pdfJob.pct}%` : `${clipPart} · ${pdfPart}`;
      return `
        <div class="vc-cta">
          <button class="vc-main running" disabled>
            <i class="vc-fill" style="width:${pct}%"></i>
            <span>保存中… ${pct}%</span>
          </button>
          <small class="vc-sub">${ui.esc(sub)}</small>
        </div>`;
    }
    if (s.pdfTab && s.pdfJob.status === 'done') {
      return `
        <div class="vc-cta">
          <button class="vc-main done" data-action="alert">打开云盘 PDF ↗</button>
          <small class="vc-sub">已存 🗂 ${ui.esc(s.folder)} · 此页是 PDF，未创建剪藏文档</small>
        </div>`;
    }
    if (s.clip.status === 'done' && s.pdfJob.status === 'done') {
      return `
        <div class="vc-cta vc-pair">
          <button class="vc-main done" data-action="alert">打开飞书文档 ↗</button>
          <button class="vc-second" data-action="alert">云盘 PDF ↗</button>
        </div>`;
    }
    if (s.pdfJob.status === 'failed') {
      return `
        <div class="vc-cta vc-pair">
          <button class="vc-main done" data-action="alert">打开飞书文档 ↗</button>
          <button class="vc-second warn" data-action="retry-pdf">PDF 失败 · 重试</button>
        </div>
        <small class="vc-sub" style="padding:0 2px">文档已保存 ✓，PDF 上传失败（网络错误），互不影响。</small>`;
    }
    if (s.clip.status === 'failed') {
      return `
        <div class="vc-cta vc-pair">
          <button class="vc-main warn" data-action="retry-clip">重试文档</button>
          <button class="vc-second" data-action="alert">云盘 PDF ↗</button>
        </div>
        <small class="vc-sub" style="padding:0 2px">文档创建失败（Bridge 超时）；PDF 已存云盘 ✓。</small>`;
    }
    const label = s.pdfTab ? '⬇ 保存 PDF 到云盘' : s.pdfOn && s.detected ? '⬇ 保存到飞书 + PDF' : '⬇ 保存到飞书';
    return `
      <div class="vc-cta">
        <button class="vc-main" data-action="save">${label}</button>
        ${s.pdfTab ? '<small class="vc-sub">此页是 PDF：仅上传云盘，不创建剪藏文档</small>' : ''}
      </div>`;
  }

  window.VARIANT_C = {
    name: 'C — 主按钮承载',
    render(s, ui) {
      return `
        ${ui.hero(s)}
        ${banner(s, ui)}
        <div class="ps-body">
          ${s.pdfTab ? '' : ui.presetsRow()}
          ${cta(s, ui)}
          <small class="ps-fine">每次点击都会创建一篇新文档。关闭弹窗不会中断保存。</small>
        </div>`;
    },
  };
})();
