// PROTOTYPE — 外壳：变体切换（?variant= + 底部浮动条 + ←/→）、事件委托、控制台强制状态（?scenario=）。
(function () {
  const VARIANTS = { A: window.VARIANT_A, B: window.VARIANT_B, C: window.VARIANT_C };
  const KEYS = Object.keys(VARIANTS);
  const SCENARIOS = [
    ['ready', '就绪'], ['trigger', '规则命中'], ['copied', '已复制'], ['filed', '已存文件'], ['offline', 'Bridge 离线'],
  ];

  const frame = document.getElementById('frame');
  const consoleBar = document.getElementById('console');
  const vname = document.getElementById('vname');
  const { state, actions, helpers, onChange } = window.PROTO;

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
    frame.innerHTML = VARIANTS[key].render(state, helpers);
    vname.textContent = VARIANTS[key].name;
    consoleBar.querySelectorAll('button').forEach((btn) => btn.classList.toggle('on', btn.dataset.scenario === state.scenario));
    // 输入触发重渲后恢复焦点（光标移到末尾）
    if (state.wantFocus) {
      const input = frame.querySelector(`[data-field="${state.wantFocus}"]`);
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      state.wantFocus = null;
    }
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
    const { action, id, menu } = el.dataset;
    if (action === 'set-preset') actions.setPreset(id);
    else if (action === 'run-action') actions.runAction(id);
    else if (action === 'reset-title') actions.resetTitle();
    else if (action === 'toggle-settings') actions.toggleSettings();
    else if (action === 'toggle-preview') actions.togglePreview();
    else if (action === 'toggle-images') actions.toggleImages();
    else if (action === 'toggle-menu') actions.toggleMenu(menu);
    else if (action === 'close-menus') actions.closeMenus();
    else if (action === 'fake-target') actions.fakeTarget();
    else if (action === 'open-settings') alert('原型：这里会打开设置页（预设与规则管理）');
  });

  frame.addEventListener('input', (event) => {
    const field = event.target.dataset.field;
    if (field === 'title') actions.editTitle(event.target.value);
    else if (field === 'append') actions.editAppend(event.target.value);
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
  // ?scenario=trigger 等：直接强制进入某状态；?preview=1 / ?settings=1 展开折叠区，便于截图与分享
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario');
  if (scenario && SCENARIOS.some(([name]) => name === scenario)) actions.setScenario(scenario);
  if (params.get('preview') === '1') { state.previewOpen = true; }
  if (params.get('settings') === '1') { state.settingsOpen = true; }
  // ?menu=split|preset|more 直接展开对应菜单，便于截图
  const menu = params.get('menu');
  if (['split', 'preset', 'more'].includes(menu)) { state.openMenu = menu; }
  render();
})();
