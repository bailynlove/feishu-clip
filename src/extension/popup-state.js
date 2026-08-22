// 弹窗 job 状态的纯归约逻辑。recovered 表示该 attempt 是打开弹窗时从存储恢复的旧会话：
// 旧会话的终态只作提示，不得把「保存到飞书」主按钮换成「打开文档」——用户可能正准备发起新剪藏。

import { createDefaultPreset } from './presets.js';
import { buildContext, composeClipBody, renderTemplate, renderTitle } from './templates.js';

export const TERMINAL_STATUSES = new Set(['succeeded', 'succeeded_with_warnings', 'failed', 'needs_attention', 'expired', 'cancelled', 'cancelled_with_document']);

export function describeJobView(job, { recovered = false } = {}) {
  if (job.status === 'succeeded' || job.status === 'succeeded_with_warnings') {
    const warning = job.status === 'succeeded_with_warnings';
    return {
      kind: warning ? 'warning' : 'success',
      message: warning ? `正文已保存；${job.warnings.length} 张图片需要注意。` : '已保存到飞书。',
      swapPrimary: !recovered,
      documentUrl: job.document?.url || null,
    };
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    return { kind: 'failure', message: job.error || '剪藏未完成，请修复后重新发起。', swapPrimary: false, documentUrl: null };
  }
  return {
    kind: 'progress',
    message: job.status === 'queued' ? '已提交，等待本地 Bridge 处理…' : '正在创建飞书文档并处理图片…',
    swapPrimary: false,
    documentUrl: null,
  };
}

// ——— 预设选择与可编辑标题（#36）：纯函数，state 只携带数据，DOM 同步由 popup.js 负责 ———

// 标题模板上下文只需 tab 信息 + 当前时间；content 在标题模板里无意义，不为此跑 extractor
export function buildTitleContext(tab, now = new Date()) {
  return buildContext({ title: tab?.title || '当前页面', sourceUrl: tab?.url || '', capturedAt: now });
}

export function currentPreset(state) {
  return state.presets.find((preset) => preset.id === state.presetId) ?? state.presets[0];
}

function renderCurrentTitle(state) {
  return renderTitle(currentPreset(state).titleTemplate, state.titleContext);
}

// 预设是顶层单位：自带保存目标与 includeImages（#29）。选中预设即应用其参数；
// temporary 仅属于用户手动用选择器覆盖的「仅本次」临时目标，预设自带目标不亮徽标
function applyPresetParams(state) {
  const preset = currentPreset(state);
  return { ...state, destination: preset.destination ?? null, temporary: false, includeImages: preset.includeImages !== false };
}

// ——— triggers 自动命中（#39）：规则语法与设置页校验一致（#35，决议 #32）———
// 普通字符串 = 前缀匹配；/pattern/ = 正则（仅支持 i 标志）。
// 优先级：前缀 > 正则；前缀取最长，等长按预设列表顺序；正则同为命中按预设列表顺序。
// 规则在设置页保存时已校验，这里对非法输入仅防御性跳过。

const REGEX_TRIGGER = /^\/(.+)\/([a-z]*)$/;

function parseRegexTrigger(trigger) {
  const match = REGEX_TRIGGER.exec(trigger);
  if (!match || !/^i*$/.test(match[2])) return null;
  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return null;
  }
}

// 返回命中的预设 id，无命中返回 null
export function matchTrigger(presets, url) {
  if (!Array.isArray(presets) || typeof url !== 'string' || url === '') return null;
  let bestPrefix = null; // { presetId, length, index }
  let firstRegex = null; // { presetId, index }
  presets.forEach((preset, index) => {
    for (const trigger of preset.triggers ?? []) {
      if (typeof trigger !== 'string' || trigger === '') continue;
      const regex = parseRegexTrigger(trigger);
      if (regex) {
        if (!firstRegex && regex.test(url)) firstRegex = { presetId: preset.id, index };
      } else if (url.startsWith(trigger)) {
        if (!bestPrefix || trigger.length > bestPrefix.length || (trigger.length === bestPrefix.length && index < bestPrefix.index)) {
          bestPrefix = { presetId: preset.id, length: trigger.length, index };
        }
      }
    }
  });
  return (bestPrefix ?? firstRegex)?.presetId ?? null;
}

// 打开弹窗：先用当前页 URL 跑 trigger 匹配，命中则选中命中预设并亮 viaTrigger 提示；
// 无命中选默认预设。应用选中预设的目标/图片参数并按其 titleTemplate 渲染标题初值；
// 无预设时兜底为迁移生成的「默认」预设（正常路径 background 已迁移好，这里防御旧数据）
export function initPopupPresets({ presets, defaultPresetId } = {}, tab, now) {
  const list = Array.isArray(presets) && presets.length > 0 ? presets : [createDefaultPreset()];
  const matchedId = matchTrigger(list, tab?.url);
  const selected = (matchedId ? list.find((preset) => preset.id === matchedId) : null) ?? list.find((preset) => preset.id === defaultPresetId) ?? list[0];
  const state = applyPresetParams({ presets: list, presetId: selected.id, titleContext: buildTitleContext(tab, now) });
  // 追加正文与两个折叠区都是仅本次会话状态：#36 起弹窗一律不回写预设
  return { ...state, title: renderCurrentTitle(state), appendNote: '', settingsOpen: false, previewOpen: false, viaTrigger: Boolean(matchedId) };
}

// 手改检测：输入框值 ≠ 当前预设模板渲染值即视为手改；初始值与 ↺ 重置值都等于渲染值
export function isTitleEdited(state) {
  return state.title !== renderCurrentTitle(state);
}

// 切换预设：应用新预设的保存目标与 includeImages，并清除之前的「仅本次」临时目标
// （三级语义：默认预设 → 选中预设 → 仅本次覆盖，换预设即从该预设重新起算）；
// 标题未手改时按新预设模板重渲，手改过则保留用户内容；
// 手动切换即脱离 trigger 命中态：提示消失，当次会话不再跑 trigger（重开弹窗重新匹配）
export function selectPreset(state, presetId) {
  if (presetId === state.presetId || !state.presets.some((preset) => preset.id === presetId)) return state;
  const next = applyPresetParams({ ...state, presetId, viaTrigger: false });
  if (!isTitleEdited(state)) next.title = renderCurrentTitle(next);
  return next;
}

// 手动「仅本次」目标覆盖：只影响当前预设会话，不回写预设
export function overrideDestination(state, destination) {
  return { ...state, destination: destination ?? null, temporary: true };
}

// ——— 保存为新预设（#40）———

function sameDestination(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// 「本次设置与所选预设不一致」的判定口径：仅比较预设字段中弹窗可改的两项——
// 保存目标（按值比较，手动覆盖成相同目标不算修改）与包含图片。
// 标题框（逐篇渲染，语义 B）与追加正文（逐篇内容）不是预设字段，不参与判定。
export function isSessionModified(state) {
  const preset = currentPreset(state);
  return !sameDestination(state.destination, preset.destination ?? null) || state.includeImages !== (preset.includeImages !== false);
}

// 包含图片 switch 的仅本次改动：写回 state 以便 diff 判定与保存时读取
export function setIncludeImages(state, includeImages) {
  return { ...state, includeImages: includeImages !== false };
}

// 构造并选中新预设：继承所选预设全部字段，用当前一次性设置覆盖 destination/includeImages；
// triggers 拷贝继承（与设置页 duplicatePreset 的副本语义一致），重名允许（以 id 区分）。
// 空名返回 null 由调用方拦截。选中不走 selectPreset——新预设的目标就是当前目标，
// 不能按「换预设清仅本次」的路径把它清掉。
export function saveAsNewPreset(state, name) {
  const trimmed = String(name ?? '').trim();
  if (trimmed === '') return null;
  const source = currentPreset(state);
  const preset = {
    ...source,
    id: crypto.randomUUID(),
    name: trimmed,
    destination: state.destination,
    includeImages: state.includeImages,
    triggers: [...(source.triggers ?? [])],
  };
  const next = { ...state, presets: [...state.presets, preset], presetId: preset.id, temporary: false, viaTrigger: false };
  // 标题模板继承自源预设，渲染值通常不变；仅在未手改时形式上重渲，语义与 selectPreset 一致
  if (!isTitleEdited(state)) next.title = renderCurrentTitle(next);
  return { state: next, preset };
}

export function editTitle(state, value) {
  return { ...state, title: String(value ?? '') };
}

export function resetTitle(state) {
  return { ...state, title: renderCurrentTitle(state) };
}

// 语义 B：保存时把标题框当前字符串当作模板，用打开弹窗时的页面上下文再渲一次。
// 未手改时初始值已是渲染结果、不含 {{}}，二次渲染幂等；渲染出空白由 background 的
// sanitizeClipTitle 判空，回退 extractor 标题。不用 renderTitle（它会回退 ctx.title）。
export function finalTitle(state) {
  return renderTemplate(state.title, state.titleContext);
}

// ——— 本次设置折叠区 + 预览（#37）———

// 追加正文（仅本次）：原样存放，合成时按语义 B 走同一 renderTemplate 路径
export function editAppend(state, value) {
  return { ...state, appendNote: String(value ?? '') };
}

// 两个折叠区（settings / preview）状态独立，互不影响（#33 原型决议）
export function toggleSection(state, section) {
  const key = section === 'settings' ? 'settingsOpen' : section === 'preview' ? 'previewOpen' : null;
  if (!key) return state;
  return { ...state, [key]: !state[key] };
}

// 预览上下文：与 background 保存路径一致——标题用 finalTitle（保存时的最终标题），
// content/url/host/capturedAt 来自懒提取的 extractor 快照
export function buildPreviewContext(snapshot, state) {
  return buildContext({ ...snapshot, title: finalTitle(state) });
}

// 预览文本 = 最终保存正文：与 background CLIP 走同一个 composeClipBody
export function previewBody(state, snapshot) {
  return composeClipBody(currentPreset(state).bodyTemplate, state.appendNote, buildPreviewContext(snapshot, state));
}

// 预览滚动决策（#37 验收 bug 修复）：追加正文合成在正文末尾，而预览是 180px 内滚区，
// 视口停在顶部时用户看不到刚输入的追加内容。trigger 为 'append'（追加正文输入）时
// 滚到底；'open'（展开预览）时仅当已有追加正文才滚到底；其余重渲保持滚动位置。
export function shouldScrollPreviewToEnd(trigger, state) {
  if (trigger === 'append') return true;
  if (trigger === 'open') return state.appendNote.trim() !== '';
  return false;
}

// 主按钮文字跟随当前预设默认动作；split 按钮与导出动作实现归 #38
const PRIMARY_LABELS = {
  feishu: '⬇ 保存到飞书',
  clipboard: '复制到剪贴板',
  file: '保存为文件',
};

export function primaryLabel(action) {
  return PRIMARY_LABELS[action] ?? PRIMARY_LABELS.feishu;
}
