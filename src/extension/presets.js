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

// 幂等：service worker 冷启动会反复调用。无 presets 时从旧 destination 迁移；
// 有 presets 时仅修复悬空的 defaultPresetId。legacy destination 键只作为迁移输入，
// 迁移完成后删除（expand–contract 收尾，#35）。
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
  if ('destination' in stored) await storage.remove('destination');
  return { presets, defaultPresetId };
}

// 保存默认预设的保存目标（只写预设；旧 destination 键已在 #35 移除）。
// 设置页预设管理上线后不再调用，保留给 SAVE_DESTINATION 消息兼容。
export async function saveDefaultDestination(storage, destination) {
  const { presets, defaultPresetId } = await ensurePresets(storage);
  const updated = presets.map((preset) => (preset.id === defaultPresetId ? { ...preset, destination } : preset));
  await storage.set({ presets: updated });
  return { presets: updated, defaultPresetId };
}
