// PROTOTYPE — mock 状态：popup「本次设置」加临时 AI 摘要（开关 / provider 预设 / 临时指令）。
// 三态心智：初始跟随当前预设的 digest 配置；用户改动任一字段即「仅本次」覆盖（overridden），
// 可一键恢复跟随预设。场景按钮强制预设侧状态，便于对照三种开局。
window.PROTO = (() => {
  const listeners = [];
  const SCENARIOS = {
    'preset-on': { presetDigest: { on: true, provider: 'deepseek' } },
    'preset-off': { presetDigest: { on: false, provider: '默认' } },
    'no-provider': { presetDigest: { on: false, provider: '默认' }, noProvider: true },
  };
  const state = {
    scenario: 'preset-on',
    settingsOpen: true,
    aiFoldOpen: true, // 变体 B 的子折叠
    preset: 'papers',
    providers: ['默认', 'deepseek', 'kimi'],
    digest: null,
    wantFocus: null,
  };
  const scenario = () => SCENARIOS[state.scenario];
  function resetDigest() {
    const p = scenario().presetDigest;
    state.digest = { on: p.on, provider: p.provider, instruction: '', overridden: false };
  }
  resetDigest();
  const emit = () => listeners.forEach((f) => f());
  const actions = {
    setScenario(name) { state.scenario = name; resetDigest(); emit(); },
    toggleSettings() { state.settingsOpen = !state.settingsOpen; emit(); },
    toggleAiFold() { state.aiFoldOpen = !state.aiFoldOpen; emit(); },
    toggleDigest() { state.digest.on = !state.digest.on; state.digest.overridden = true; emit(); },
    setProvider(name) { state.digest.provider = name; state.digest.overridden = true; emit(); },
    editInstruction(text) { state.digest.instruction = text; state.digest.overridden = true; state.wantFocus = 'digest-instruction'; emit(); },
    resetDigestOverride() { resetDigest(); emit(); },
    enterDigestOverride() { state.digest.overridden = true; emit(); },
  };
  const helpers = {
    presetDigest: () => scenario().presetDigest,
    providers: () => (scenario().noProvider ? [] : state.providers),
    // 跟随状态的一行摘要：「开 · deepseek」/「关」
    followSummary: () => {
      const p = scenario().presetDigest;
      return p.on ? `开 · ${p.provider}` : '关';
    },
  };
  return {
    state, actions, helpers,
    scenarioList: [['preset-on', '预设已开摘要'], ['preset-off', '预设未开摘要'], ['no-provider', '未配置 provider']],
    onChange: (f) => listeners.push(f),
  };
})();
