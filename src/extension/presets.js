// 预设存储层：chrome.storage.local 的 presets 数组 + defaultPresetId。
// storage 参数只要求 get/set/remove（chrome.storage.local 或内存 stub）。

export function createDefaultPreset(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: '默认',
    destination: null,
    imageMode: 'preview',
    titleTemplate: '{{title}}',
    bodyTemplate: '',
    action: 'feishu',
    triggers: [],
    ...overrides,
  };
}

// 图片写入模式（#53）：preview 预览优先 / download 下载优先 / off 不保存。
// 存量预设只有 includeImages 布尔：false → off，其余 → preview；读取时迁移，不强转存储格式。
export const IMAGE_MODES = ['preview', 'download', 'off'];

export function resolveImageMode(preset) {
  if (IMAGE_MODES.includes(preset?.imageMode)) return preset.imageMode;
  return preset?.includeImages === false ? 'off' : 'preview';
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
