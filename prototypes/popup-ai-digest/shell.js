// PROTOTYPE — 外壳：变体切换（?variant= + 底部浮动条 + ←/→）、事件委托、场景控制台（?scenario=）。
(function () {
  const VARIANTS = { A: window.VARIANT_A, B: window.VARIANT_B, C: window.VARIANT_C };
  const KEYS = Object.keys(VARIANTS);
  const frame = document.getElementById('frame');
  const consoleBar = document.getElementById('console');
  const vname = document.getElementById('vname');
  const { state, actions, helpers, scenarioList, onChange } = window.PROTO;

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
    const html = VARIANTS[key].render(state, helpers);
    // 抽出 <body class="popup"> 内容并补回 .popup 作用域——ui.css 的弹窗样式全部限定 .popup 才有
    const inner = html.replace(/^[\s\S]*?<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '');
    frame.innerHTML = `<div class="popup">${inner}</div>`;
    vname.textContent = VARIANTS[key].name;
    consoleBar.querySelectorAll('button').forEach((btn) => btn.classList.toggle('on', btn.dataset.scenario === state.scenario));
    if (state.wantFocus) {
      const input = frame.querySelector(`[data-field="${state.wantFocus}"]`);
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      state.wantFocus = null;
    }
  }

  for (const [scenario, label] of scenarioList) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.dataset.scenario = scenario;
    btn.addEventListener('click', () => actions.setScenario(scenario));
    consoleBar.append(btn);
  }

  frame.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    if (action === 'toggle-settings') actions.toggleSettings();
    else if (action === 'toggle-ai-fold') actions.toggleAiFold();
    else if (action === 'set-provider') actions.setProvider(id);
    else if (action === 'reset-digest') actions.resetDigestOverride();
    else if (action === 'toggle-digest-override') actions.enterDigestOverride();
  });

  frame.addEventListener('change', (event) => {
    const field = event.target.dataset.field;
    if (field === 'digest-on') actions.toggleDigest();
    else if (field === 'digest-provider') actions.setProvider(event.target.value);
  });

  frame.addEventListener('input', (event) => {
    if (event.target.dataset.field === 'digest-instruction') actions.editInstruction(event.target.value);
  });

  document.getElementById('prev').addEventListener('click', () => cycle(-1));
  document.getElementById('next').addEventListener('click', () => cycle(1));
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
    if (event.key === 'ArrowLeft') cycle(-1);
    if (event.key === 'ArrowRight') cycle(1);
  });

  onChange(render);
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario');
  if (scenario && scenarioList.some(([name]) => name === scenario)) actions.setScenario(scenario);
  render();
})();
