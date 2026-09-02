// 设置页预设管理的纯归约逻辑（#35）：不依赖 DOM 或 chrome API，node:test 直接测。
// state 形状：{ presets: [...], defaultPresetId }，与 chrome.storage 里的形状一致。
// 所有操作返回新 state；删除到最后一套等非法操作返回 null 表示拒绝。

import { createDefaultPreset } from './presets.js';

// 模板变量快捷插入（决议 #30 的 v1 变量集）
export const TEMPLATE_VARIABLES = ['title', 'url', 'host', 'date', 'time', 'datetime', 'content'];

// 图片写入模式三态（#53）：选项顺序即设置页分段控件顺序；说明文案体现三者的取舍
export const IMAGE_MODE_OPTIONS = [
  { value: 'preview', label: '预览优先', hint: '公开图片直接嵌入预览块，最快；依赖原站可持续访问' },
  { value: 'download', label: '下载优先', hint: '公开图片也下载上传为真实图片，较慢但更持久' },
  { value: 'off', label: '不保存', hint: '不保存图片，原位保留可读文本与原图链接' },
];

export function imageModeHint(mode) {
  return (IMAGE_MODE_OPTIONS.find((option) => option.value === mode) ?? IMAGE_MODE_OPTIONS[0]).hint;
}

function findIndex(state, id) {
  return state.presets.findIndex((preset) => preset.id === id);
}

export function updatePreset(state, id, patch) {
  const index = findIndex(state, id);
  if (index < 0) return state;
  const presets = state.presets.slice();
  presets[index] = { ...presets[index], ...patch };
  return { ...state, presets };
}

export function renamePreset(state, id, name) {
  return updatePreset(state, id, { name: String(name ?? '') });
}

export function addPreset(state) {
  const preset = createDefaultPreset({ name: `预设 ${state.presets.length + 1}` });
  return { ...state, presets: [...state.presets, preset] };
}

// 复制：新 id、名称加「副本」，插在原预设之后
export function duplicatePreset(state, id) {
  const index = findIndex(state, id);
  if (index < 0) return state;
  const source = state.presets[index];
  const copy = { ...source, id: crypto.randomUUID(), name: `${source.name} 副本`, triggers: [...source.triggers] };
  const presets = state.presets.slice();
  presets.splice(index + 1, 0, copy);
  return { ...state, presets };
}

// 至少保留一套：只剩一套时拒绝删除（返回 null）。
// 删除默认预设时默认顺延列表第一套（决议 #29）。
export function removePreset(state, id) {
  if (state.presets.length <= 1) return null;
  const index = findIndex(state, id);
  if (index < 0) return state;
  const presets = state.presets.filter((preset) => preset.id !== id);
  const defaultPresetId = state.defaultPresetId === id ? presets[0].id : state.defaultPresetId;
  return { ...state, presets, defaultPresetId };
}

// delta -1 上移 / +1 下移；越界时原地不动
export function movePreset(state, id, delta) {
  const index = findIndex(state, id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.presets.length) return state;
  const presets = state.presets.slice();
  [presets[index], presets[target]] = [presets[target], presets[index]];
  return { ...state, presets };
}

export function setDefaultPreset(state, id) {
  if (findIndex(state, id) < 0) return state;
  return { ...state, defaultPresetId: id };
}

// ——— triggers 规则校验（决议 #32）：一行一条 ———
// 合法：前缀以 http(s):// 开头；或 /pattern/（可带 i 标志）且 new RegExp 不抛错。
// 返回 { line, text, reason } 列表，line 为 1 起始行号；空行跳过。

const REGEX_RULE = /^\/(.+)\/([a-z]*)$/;

function validateRule(text) {
  const regex = REGEX_RULE.exec(text);
  if (regex) {
    const [, pattern, flags] = regex;
    if (!/^[i]*$/.test(flags)) return '正则只支持 i 标志';
    try {
      new RegExp(pattern, flags);
    } catch {
      return '正则表达式非法';
    }
    return null;
  }
  if (text.startsWith('/')) return '正则须写成 /pattern/ 形式';
  if (!/^https?:\/\//.test(text)) return '前缀须以 http(s):// 开头';
  return null;
}

export function validateTriggers(text) {
  const errors = [];
  String(text ?? '')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === '') return;
      const reason = validateRule(line);
      if (reason) errors.push({ line: index + 1, text: line, reason });
    });
  return errors;
}

// 解析为规则数组：去空行、去首尾空白。调用前应先过 validateTriggers。
export function parseTriggers(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// 变量快捷插入：在 cursor 处插入 {{name}}，返回新文本与新光标位置（插入内容之后）
export function insertVariable(text, cursor, name) {
  const value = String(text ?? '');
  const at = Math.max(0, Math.min(Number(cursor) || 0, value.length));
  const snippet = `{{${name}}}`;
  return { text: value.slice(0, at) + snippet + value.slice(at), cursor: at + snippet.length };
}

// ——— 开发者模式：任务耗时日志的纯展示逻辑 ———
// 输入为 bridge GET /v1/jobs 返回的 job 对象；输出全部是给 DOM 渲染用的字符串/结构化行，
// 不碰 DOM 与 chrome API，node:test 直测。

// 状态归类：决定任务行状态点的颜色（成功绿/警告黄/失败红/进行中蓝）。
// cancelled* 是用户主动行为不算失败，归警告；needs_attention/expired 需要用户介入，归失败。
export function jobStatusTone(status) {
  switch (status) {
    case 'succeeded': return 'success';
    case 'succeeded_with_warnings':
    case 'cancelled':
    case 'cancelled_with_document': return 'warning';
    case 'queued':
    case 'running': return 'running';
    default: return 'error';
  }
}

// 状态中文标签，跟状态点并排展示
export function jobStatusLabel(status) {
  switch (status) {
    case 'succeeded': return '成功';
    case 'succeeded_with_warnings': return '有警告';
    case 'failed': return '失败';
    case 'needs_attention': return '需处理';
    case 'expired': return '已过期';
    case 'cancelled': return '已取消';
    case 'cancelled_with_document': return '已取消（文档已建）';
    case 'queued': return '排队中';
    case 'running': return '进行中';
    default: return String(status ?? '未知');
  }
}

// 耗时格式化：<1s 显示毫秒（页面提取常在此区间），否则保留一位小数的秒
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// 任务行总耗时列：进行中（未终态）显示「进行中」，终态无 totalMs（老数据）显示「—」
export function jobTotalLabel(job) {
  if (jobStatusTone(job?.status) === 'running') return '进行中';
  return formatDuration(job?.totalMs);
}

// 开始时间 HH:MM:SS（本地时区）；缺 createdAt 时兜底
export function formatClock(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—';
  const date = new Date(epochMs);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 任务行标题：bridge 记录的剪藏标题优先；无标题回退来源 host，再退完整 URL
export function jobDisplayTitle(job) {
  const title = String(job?.title ?? '').trim();
  if (title) return title;
  try {
    return new URL(job?.sourceUrl).host;
  } catch {
    return String(job?.sourceUrl ?? '') || '未知任务';
  }
}

// stage 的 name 是机器标识，展示用中文名
const STAGE_LABELS = { create_document: '创建文档', images: '图片处理' };

// 展开明细行：页面提取（扩展侧 clientTiming）+ bridge timeline 按原顺序平铺。
// 每行 { label, value, indent, failed }；indent 用于缩进层级（stage 0 / image 1 / cli 2）。
export function jobDetailRows(job) {
  const rows = [];
  const extractMs = job?.clientTiming?.extractMs;
  if (typeof extractMs === 'number') {
    rows.push({ label: '页面提取', value: formatDuration(extractMs), indent: 0, failed: false });
  }
  for (const entry of job?.timeline ?? []) {
    if (entry?.kind === 'stage') {
      rows.push({ label: STAGE_LABELS[entry.name] ?? String(entry.name ?? ''), value: formatDuration(entry.ms), indent: 0, failed: false });
    } else if (entry?.kind === 'image') {
      // name 形如 image-<n>；失败时 detail 为原因
      const label = String(entry.name ?? '').replace(/^image-/, '图片 ');
      if (entry.detail) rows.push({ label, value: `失败：${entry.detail}`, indent: 1, failed: true });
      else rows.push({ label, value: formatDuration(entry.ms), indent: 1, failed: false });
    } else if (entry?.kind === 'cli') {
      rows.push({ label: String(entry.name ?? ''), value: formatDuration(entry.ms), indent: 2, failed: false });
    }
  }
  return rows;
}
