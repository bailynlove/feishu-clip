// PROTOTYPE — PDF 云盘模式弹窗模拟状态（#59）：场景集、本次 PDF 开关/目录、双独立 job 状态。
(function () {
  const FOLDERS = ['Papers/2026', 'Papers/Attention', '云盘根目录'];

  const state = {
    scenario: 'none',
    pdfTab: false,        // 标签页本身是 PDF（内嵌查看器）
    detected: false,      // HTML 论文页识别到主 PDF
    presetPdf: false,     // 预设里的「PDF 存云盘」开关
    pdfOn: false,         // 本次开关（改动不回写预设）
    folder: FOLDERS[0],
    settingsOpen: false,
    clip: { status: 'idle', pct: 0 },    // idle | running | done | failed
    pdfJob: { status: 'idle', pct: 0 },
    page: { title: 'Attention Is All You Need', host: 'arxiv.org' },
    pdf: { name: '1706.03762v3.pdf', sizeMB: 12.4 },
  };

  const SCENARIOS = {
    none:           {},
    detected_off:   { detected: true },
    on_ready:       { detected: true, presetPdf: true, pdfOn: true },
    running:        { detected: true, presetPdf: true, pdfOn: true, clip: { status: 'running', pct: 62 }, pdfJob: { status: 'running', pct: 34 } },
    done:           { detected: true, presetPdf: true, pdfOn: true, clip: { status: 'done', pct: 100 }, pdfJob: { status: 'done', pct: 100 } },
    pdf_failed:     { detected: true, presetPdf: true, pdfOn: true, clip: { status: 'done', pct: 100 }, pdfJob: { status: 'failed', pct: 71 } },
    doc_failed:     { detected: true, presetPdf: true, pdfOn: true, clip: { status: 'failed', pct: 40 }, pdfJob: { status: 'done', pct: 100 } },
    pdf_tab:        { pdfTab: true, detected: true, presetPdf: true, pdfOn: true },
    pdf_tab_running:{ pdfTab: true, detected: true, presetPdf: true, pdfOn: true, pdfJob: { status: 'running', pct: 48 } },
    pdf_tab_done:   { pdfTab: true, detected: true, presetPdf: true, pdfOn: true, pdfJob: { status: 'done', pct: 100 } },
  };

  function base() {
    return {
      pdfTab: false, detected: false, presetPdf: false, pdfOn: false,
      folder: FOLDERS[0], settingsOpen: false,
      clip: { status: 'idle', pct: 0 }, pdfJob: { status: 'idle', pct: 0 },
    };
  }

  const listeners = new Set();
  function emit() { listeners.forEach((fn) => fn()); }

  const actions = {
    setScenario(name) {
      Object.assign(state, base(), structuredClone(SCENARIOS[name] ?? {}), { scenario: name });
      emit();
    },
    togglePdf() { state.pdfOn = !state.pdfOn; emit(); },
    cycleFolder() {
      state.folder = FOLDERS[(FOLDERS.indexOf(state.folder) + 1) % FOLDERS.length];
      emit();
    },
    toggleSettings() { state.settingsOpen = !state.settingsOpen; emit(); },
    save() {
      if (state.pdfTab) actions.setScenario('pdf_tab_running');
      else if (state.clip.status === 'idle') actions.setScenario('running');
    },
    retryPdf() { actions.setScenario(state.pdfTab ? 'pdf_tab_done' : 'done'); },
    retryClip() { actions.setScenario('running'); },
  };

  window.PROTO = {
    state,
    actions,
    onChange(fn) { listeners.add(fn); },
  };
})();
