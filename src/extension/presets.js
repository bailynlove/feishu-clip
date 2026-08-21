// 预设存储层：chrome.storage.local 的 presets 数组 + defaultPresetId。
// storage 参数只要求 get/set/remove（chrome.storage.local 或内存 stub）。

export function createDefaultPreset(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: '默认',
    destination: null,
    includeImages: true,
    titleTemplate: '{{title}}',
    bodyTemplate: '',
    action: 'feishu',
    triggers: [],
    ...overrides,
  };
}

// destination 双写是过渡态：生产弹窗（popup.js/options.js）仍读旧 destination 键，
// #36 切换到预设后移除此键与本函数。
async function syncLegacyDestination(storage, presets, defaultPresetId) {
  const current = presets.find((preset) => preset.id === defaultPresetId);
  if (current?.destination) await storage.set({ destination: current.destination });
  else await storage.remove('destination');
}

// 幂等：service worker 冷启动会反复调用。无 presets 时从旧 destination 迁移；
// 有 presets 时仅修复悬空的 defaultPresetId，并把旧 destination 键对齐默认预设。
export async function ensurePresets(storage) {
  const stored = await storage.get(['presets', 'defaultPresetId', 'destination']);
  let presets = Array.isArray(stored.presets) && stored.presets.length > 0 ? stored.presets : null;
  let defaultPresetId = stored.defaultPresetId;
  if (!presets) {
    const preset = createDefaultPreset({ destination: stored.destination ?? null });
    presets = [preset];
    defaultPresetId = preset.id;
    await storage.set({ presets, defaultPresetId });
  } else if (!presets.some((preset) => preset.id === defaultPresetId)) {
    defaultPresetId = presets[0].id;
    await storage.set({ defaultPresetId });
  }
  await syncLegacyDestination(storage, presets, defaultPresetId);
  return { presets, defaultPresetId };
}

// 写路径双写：更新默认预设的 destination，同时写旧 destination 键（过渡态，#36 后移除旧键）。
export async function saveDefaultDestination(storage, destination) {
  const { presets, defaultPresetId } = await ensurePresets(storage);
  const updated = presets.map((preset) => (preset.id === defaultPresetId ? { ...preset, destination } : preset));
  await storage.set({ presets: updated, destination });
  return { presets: updated, defaultPresetId };
}
