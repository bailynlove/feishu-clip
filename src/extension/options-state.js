// 设置页预设管理的纯归约逻辑（#35）：不依赖 DOM 或 chrome API，node:test 直接测。
// state 形状：{ presets: [...], defaultPresetId }，与 chrome.storage 里的形状一致。
// 所有操作返回新 state；删除到最后一套等非法操作返回 null 表示拒绝。

import { createDefaultPreset } from './presets.js';

export const PRESET_ACTIONS = ['feishu', 'clipboard', 'file'];

// 模板变量快捷插入（决议 #30 的 v1 变量集）
export const TEMPLATE_VARIABLES = ['title', 'url', 'host', 'date', 'time', 'datetime', 'content'];

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
