// 弹窗 job 状态的纯归约逻辑。recovered 表示该 attempt 是打开弹窗时从存储恢复的旧会话：
// 旧会话的终态只作提示，不得把「保存到飞书」主按钮换成「打开文档」——用户可能正准备发起新剪藏。

import { createDefaultPreset } from './presets.js';
import { buildContext, renderTitle } from './templates.js';

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

// 打开弹窗：选中默认预设，应用其目标/图片参数并按其 titleTemplate 渲染标题初值；
// 无预设时兜底为迁移生成的「默认」预设（正常路径 background 已迁移好，这里防御旧数据）
export function initPopupPresets({ presets, defaultPresetId } = {}, tab, now) {
  const list = Array.isArray(presets) && presets.length > 0 ? presets : [createDefaultPreset()];
  const selected = list.find((preset) => preset.id === defaultPresetId) ?? list[0];
  const state = applyPresetParams({ presets: list, presetId: selected.id, titleContext: buildTitleContext(tab, now) });
  return { ...state, title: renderCurrentTitle(state) };
}

// 手改检测：输入框值 ≠ 当前预设模板渲染值即视为手改；初始值与 ↺ 重置值都等于渲染值
export function isTitleEdited(state) {
  return state.title !== renderCurrentTitle(state);
}

// 切换预设：应用新预设的保存目标与 includeImages，并清除之前的「仅本次」临时目标
// （三级语义：默认预设 → 选中预设 → 仅本次覆盖，换预设即从该预设重新起算）；
// 标题未手改时按新预设模板重渲，手改过则保留用户内容
export function selectPreset(state, presetId) {
  if (presetId === state.presetId || !state.presets.some((preset) => preset.id === presetId)) return state;
  const next = applyPresetParams({ ...state, presetId });
  if (!isTitleEdited(state)) next.title = renderCurrentTitle(next);
  return next;
}

// 手动「仅本次」目标覆盖：只影响当前预设会话，不回写预设
export function overrideDestination(state, destination) {
  return { ...state, destination: destination ?? null, temporary: true };
}

export function editTitle(state, value) {
  return { ...state, title: String(value ?? '') };
}

export function resetTitle(state) {
  return { ...state, title: renderCurrentTitle(state) };
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
