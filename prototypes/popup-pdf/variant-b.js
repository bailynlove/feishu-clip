// PROTOTYPE — 变体 B：双 job 卡片。双 job 是一等公民：各自一张卡片、各自进度与结果入口；
// 「检测到 PDF」是预设行下方的独立小节。结构差异点：状态区被两张任务卡取代。
(function () {
  const JOB_META = {
    clip: { icon: '📄', title: '剪藏文档' },
    pdf: { icon: '📕', title: 'PDF 云盘' },
  };

  function jobCard(kind, job, s, ui) {
    const meta = JOB_META[kind];
    const name = kind === 'clip' ? s.page.title : s.pdf.name;
    const badge = { running: '进行中', done: '完成 ✓', failed: '失败 ✗', idle: '等待' }[job.status];
    const tone = job.status === 'failed' ? 'err' : job.status === 'done' ? '' : '';
    const bar = job.status === 'idle' ? '' :
      `<div class="ps-progress ${tone}" style="margin-top:8px"><i style="width:${job.pct}%"></i></div>`;
    let action = '';
    if (job.status === 'done') action = `<button class="vb-card-link" data-action="alert">${kind === 'clip' ? '打开文档 ↗' : '打开云盘文件 ↗'}</button>`;
    if (job.status === 'failed') action = `<button class="vb-card-link warn" data-action="${kind === 'clip' ? 'retry-clip' : 'retry-pdf'}">重试</button>`;
    return `
      <div class="vb-card ${job.status}">
        <div class="vb-card-head">
          <span>${meta.icon}</span>
          <div class="vb-card-title"><strong>${meta.title}</strong><small>${ui.esc(name)}</small></div>
          <span class="vb-badge ${job.status}">${badge}</span>
        </div>
        ${bar}
        ${action ? `<div class="vb-card-foot">${action}</div>` : ''}
      </div>`;
  }

  function pdfSection(s, ui) {
    if (!s.detected) return '';
    if (!s.presetPdf && !s.pdfOn) {
      return `
        <section class="vb-pdfbox collapsed">
          <button class="vb-discover" data-action="enable-pdf">📕 本页包含 PDF（${s.pdf.sizeMB} MB）—— 本次存入云盘 ›</button>
        </section>`;
    }
    return `
      <section class="vb-pdfbox">
        <div class="vb-pdfbox-head"><span>📕 检测到 PDF</span><small>${ui.esc(s.pdf.name)} · ${s.pdf.sizeMB} MB</small></div>
        <div class="vb-pdfbox-row">
          <div class="ps-switch-row ${s.pdfOn ? 'on' : ''}" data-action="toggle-pdf" role="button" tabindex="0">
            <span class="ps-switch-text"><span class="ps-switch-label">存入云盘</span><span class="ps-switch-sub">${s.presetPdf ? '预设已开启' : '仅本次'}</span></span>
            <span class="ps-switch"></span>
          </div>
        </div>
        ${s.pdfOn ? `<button class="ps-target" data-action="cycle-folder"><span class="ps-target-text">🗂 ${ui.esc(s.folder)}</span><span class="ps-target-edit">更改 ›</span></button>` : ''}
      </section>`;
  }

  function jobsSection(s, ui) {
    if (s.pdfTab) {
      if (s.pdfJob.status === 'idle') return `<div class="ps-note info">此页是 PDF：仅上传云盘，不创建剪藏文档</div>`;
      return `<section class="vb-jobs">${jobCard('pdf', s.pdfJob, s, ui)}</section>`;
    }
    if (s.clip.status === 'idle' && s.pdfJob.status === 'idle') return '';
    const cards = [jobCard('clip', s.clip, s, ui)];
    if (s.pdfOn) cards.push(jobCard('pdf', s.pdfJob, s, ui));
    return `<section class="vb-jobs">${cards.join('')}</section>`;
  }

  function cta(s) {
    const busy = s.clip.status === 'running' || s.pdfJob.status === 'running';
    const allSettled = ['done', 'failed'].includes(s.clip.status) && ['done', 'failed'].includes(s.pdfJob.status);
    if (s.pdfTab) {
      if (busy) return `<button class="ps-split-main" disabled>上传中…</button>`;
      if (s.pdfJob.status === 'done') return `<button class="ps-split-main" data-action="alert">打开云盘 PDF ↗</button>`;
      return `<button class="ps-split-main" data-action="save">⬇ 保存 PDF 到云盘</button>`;
    }
    if (busy) return `<button class="ps-split-main" disabled>任务进行中…</button>`;
    if (allSettled) return `<button class="ps-split-main" data-action="alert">完成 · 关闭</button>`;
    return `
      <div class="ps-split">
        <button class="ps-split-main" data-action="save">⬇ 保存到飞书${s.pdfOn && s.detected ? ' + PDF' : ''}</button>
        <button class="ps-split-arrow" data-action="alert" title="更多动作">▾</button>
      </div>`;
  }

  window.VARIANT_B = {
    name: 'B — 双 job 卡片',
    render(s, ui) {
      return `
        ${ui.hero(s)}
        <div class="ps-body">
          ${s.pdfTab ? '' : ui.presetsRow()}
          ${s.pdfTab ? '' : pdfSection(s, ui)}
          ${jobsSection(s, ui)}
          ${cta(s)}
          <small class="ps-fine">每个任务独立成败；关闭弹窗不会中断。</small>
        </div>`;
    },
  };
})();
