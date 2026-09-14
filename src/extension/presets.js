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
    // PDF 存云盘（#65）：null | { enabled, folderToken, folderName }；folderToken 为 null 即云盘根目录
    pdfDrive: null,
    // AI 摘要（#75）：null | { enabled: true, instruction }；instruction 空串 = 用全局指令
    digest: null,
    ...overrides,
  };
}

// 内置默认摘要指令（#75）：预设级与全局指令都未设置时的最终兜底（解析顺序见 resolveDigestInstruction）；
// 同时作为设置页全局指令输入框的 placeholder
export const DEFAULT_DIGEST_INSTRUCTION = '请用与正文相同的语言，把以下网页正文总结为 3-6 条要点，每条一句话，直接输出要点列表，不要输出额外解释。';

// 图片写入模式（#53）：preview 预览优先 / download 下载优先 / off 不保存。
// 存量预设只有 includeImages 布尔：false → off，其余 → preview；读取时迁移，不强转存储格式。
export const IMAGE_MODES = ['preview', 'download', 'off'];

export function resolveImageMode(preset) {
  if (IMAGE_MODES.includes(preset?.imageMode)) return preset.imageMode;
  return preset?.includeImages === false ? 'off' : 'preview';
}

// 云盘目录对（#66）：{ folderToken, folderName } 的统一构造/归一——folderToken 为 null 即
// 云盘根目录（合法态），folderName 冗余存展示名（picker 保存结果/手贴 token 可能没有）。
// 预设 pdfDrive、会话 chip、picker 保存结果各层一律经此构造，不在各处散写 typeof 判空
export function createDriveFolder({ folderToken = null, folderName = null } = {}) {
  return {
    folderToken: typeof folderToken === 'string' && folderToken ? folderToken : null,
    folderName: typeof folderName === 'string' && folderName ? folderName : null,
  };
}

// PDF 存云盘聚合字段（#62/#65）：读取时迁移——缺字段/非法值一律归一为 null；
// enabled:true + folderToken:null = 存云盘根目录（合法态）。folderName 冗余存展示名（picker 见 #66）
export function resolvePdfDrive(preset) {
  const value = preset?.pdfDrive;
  if (!value || typeof value !== 'object' || value.enabled !== true) return null;
  return { enabled: true, ...createDriveFolder(value) };
}

// AI 摘要预设字段（#75）：读取时迁移——缺字段/非法值一律归一为 null；
// enabled:true + instruction:'' = 开启但用全局指令（空串语义在 resolveDigestInstruction 解析）；
// provider（#78）：选用的 AI provider 名，空串/缺省 = 默认 provider；
// mode（#98）：'inline' 建档前内联 / 'subdoc' 建档后写入 Digest 子文档，缺省读作 subdoc（含存量预设）
export function resolveDigest(preset) {
  const value = preset?.digest;
  if (!value || typeof value !== 'object' || value.enabled !== true) return null;
  return {
    enabled: true,
    instruction: typeof value.instruction === 'string' ? value.instruction : '',
    provider: typeof value.provider === 'string' ? value.provider.trim() : '',
    mode: value.mode === 'inline' ? 'inline' : 'subdoc',
    docTitleTemplate:
      typeof value.docTitleTemplate === 'string' && value.docTitleTemplate.trim()
        ? value.docTitleTemplate
        : DEFAULT_DIGEST_DOC_TITLE,
  };
}

// 子文档模式下 Digest 子文档的标题模板默认值（#98）：预设回落与设置页 placeholder 共用
export const DEFAULT_DIGEST_DOC_TITLE = 'Digest';

// 摘要指令解析顺序（#75）：预设级 > 全局（chrome.storage.local 的 aiDigestInstruction）> 内置默认；
// 空串/非字符串视为未设置。在 background CLIP 路径解析，弹窗只透传预设级原值
export function resolveDigestInstruction(presetInstruction, globalInstruction) {
  for (const value of [presetInstruction, globalInstruction]) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return DEFAULT_DIGEST_INSTRUCTION;
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
