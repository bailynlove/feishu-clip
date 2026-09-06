// PROTOTYPE — 外壳：变体切换（?variant= + 底部浮动条 + ←/→）、事件委托、控制台强制场景（?scenario=）。
(function () {
  const VARIANTS = { A: window.VARIANT_A, B: window.VARIANT_B, C: window.VARIANT_C };
  const KEYS = Object.keys(VARIANTS);
  const SCENARIOS = [
    ['none', '无 PDF'], ['detected_off', '检测到·预设关'], ['on_ready', '检测到·预设开'],
    ['running', '进行中'], ['done', '双成功'], ['pdf_failed', 'PDF 失败'], ['doc_failed', '文档失败'],
    ['pdf_tab', 'PDF 标签页'], ['pdf_tab_running', 'PDF 页·进行中'], ['pdf_tab_done', 'PDF 页·已传'],
  ];

  const frame = document.getElementById('frame');
  const consoleBar = document.getElementById('console');
  const vname = document.getElementById('vname');
  const { state, actions, onChange } = window.PROTO;

  function currentVariant() {
    const key = new URLSearchParams(location.search).get('variant') || 'A';
    return VARIANTS[key] ? key : 'A';
  }

  function setVariant(key) {
    const url = new URL(location.href);
    url.searchParams.set('variant', key);
    history.replaceState(null, '', url);
    render();
  }

  function cycle(delta) {
    const index = KEYS.indexOf(currentVariant());
    setVariant(KEYS[(index + delta + KEYS.length) % KEYS.length]);
  }

  function render() {
    const key = currentVariant();
    frame.className = `variant-${key.toLowerCase()}`;
    frame.innerHTML = VARIANTS[key].render(state, window.UI);
    vname.textContent = VARIANTS[key].name;
    consoleBar.querySelectorAll('button').forEach((btn) => btn.classList.toggle('on', btn.dataset.scenario === state.scenario));
  }

  for (const [scenario, label] of SCENARIOS) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.dataset.scenario = scenario;
    btn.addEventListener('click', () => actions.setScenario(scenario));
    consoleBar.append(btn);
  }

  frame.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const { action } = el.dataset;
    if (action === 'toggle-pdf') actions.togglePdf();
    else if (action === 'enable-pdf') { if (!state.pdfOn) actions.togglePdf(); }
    else if (action === 'cycle-folder') actions.cycleFolder();
    else if (action === 'toggle-settings') actions.toggleSettings();
    else if (action === 'save') actions.save();
    else if (action === 'retry-pdf') actions.retryPdf();
    else if (action === 'retry-clip') actions.retryClip();
    else if (action === 'alert') alert('原型：真实扩展中这里会执行对应动作');
  });

  document.getElementById('prev').addEventListener('click', () => cycle(-1));
  document.getElementById('next').addEventListener('click', () => cycle(1));
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    if (event.key === 'ArrowLeft') cycle(-1);
    if (event.key === 'ArrowRight') cycle(1);
  });

  onChange(render);
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario');
  if (scenario && SCENARIOS.some(([name]) => name === scenario)) actions.setScenario(scenario);
  if (params.get('settings') === '1') { state.settingsOpen = true; }
  render();
})();
