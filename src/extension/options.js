// 设置页（#35）：标签页式预设管理（C 版设计）。归约逻辑全在 options-state.js（纯函数），
// 本文件只负责 DOM 渲染与 chrome 消息。所有变更经 SAVE_PRESETS 整体写回持久化。
import { createPopupPicker } from './popup-picker.js';
import { describeDestination, renderPicker, wirePicker } from './picker-view.js';
import {
  addPreset, duplicatePreset, movePreset, removePreset, renamePreset, setDefaultPreset, updatePreset,
  validateTriggers, parseTriggers, insertVariable, TEMPLATE_VARIABLES,
} from './options-state.js';

const $ = (selector) => document.querySelector(selector);
$('#extension-id').textContent = chrome.runtime.id;

function message(payload) {
  return chrome.runtime.sendMessage(payload).then((response) => {
    if (!response?.ok) throw Object.assign(new Error(response?.error?.message || '操作失败'), response?.error);
    return response.result;
  });
}

const NOTICE_TONES = { success: 'ok', error: 'err', info: 'info' };
function show(text, kind = 'info') {
  const node = $('#status');
  node.textContent = text;
  node.className = `ps-note ${NOTICE_TONES[kind] ?? 'info'}`;
}

// 预设管理相关瞬时反馈：顶部居中浮动 toast，滑入淡入、3 秒自动消失、不挤占布局；
// Bridge 配对状态/离线等持续状态仍走页面底部的 #status，不做 toast
let toastTimer = null;
function toast(text, kind = 'info') {
  const node = $('#toast');
  node.textContent = text;
  node.className = `ps-toast show ${NOTICE_TONES[kind] ?? 'info'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3000);
}

// ——— 页面状态：presets/defaultPresetId 与存储一致；editingId 是当前选中 tab 的预设 ———
let state = { presets: [], defaultPresetId: null };
let editingId = null;
let picker = null;
let confirmDeleteId = null;
// triggers 校验失败时阻止保存：非法草稿按预设 id 留在内存里，切回该预设的 tab 时恢复并继续
// 报错，修复合法写回成功后清除。内存态即可，重开设置页页面后丢弃。
const triggerDrafts = new Map();

async function persist(quiet = false) {
  const saved = await message({ type: 'SAVE_PRESETS', presets: state.presets, defaultPresetId: state.defaultPresetId });
  state = { ...state, ...saved };
  // 文本框逐键保存不打扰；离散操作（新建/删除/排序/目标保存等）才弹「已保存」
  if (!quiet) toast('已保存 ✓', 'success');
}

function editingPreset() {
  return state.presets.find((preset) => preset.id === editingId) ?? null;
}

function applyMutation(next, { quiet = false } = {}) {
  if (!next) return false;
  state = next;
  // 预设被删后其草稿一并丢弃；当前 tab 被删时切到第一套（顺序即优先级）
  for (const id of triggerDrafts.keys()) {
    if (!state.presets.some((preset) => preset.id === id)) triggerDrafts.delete(id);
  }
  if (!editingPreset()) {
    editingId = state.presets[0]?.id ?? null;
    closePicker();
    syncEditor();
  }
  renderTabs();
  persist(quiet).catch((error) => toast(`保存失败：${error.message}`, 'error'));
  return true;
}

// ——— 标签栏：预设 tab + 内嵌小图标操作 + 末尾「＋ 新建」（C 版） ———
function inlineOps(preset, index, last) {
  const ops = document.createElement('span');
  ops.className = 'pc-tab-ops';
  const mk = (icon, title, disabled, danger, onClick) => {
    const op = document.createElement('span');
    op.className = `pc-tab-op${danger ? ' danger' : ''}`;
    op.textContent = icon;
    op.title = title;
    if (disabled) op.dataset.disabled = '1';
    else {
      op.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
      });
    }
    ops.append(op);
  };
  mk('★', '设为默认', preset.id === state.defaultPresetId, false, () => applyMutation(setDefaultPreset(state, preset.id)));
  mk('⧉', '复制此预设', false, false, () => {
    const sourceIndex = state.presets.findIndex((candidate) => candidate.id === preset.id);
    if (applyMutation(duplicatePreset(state, preset.id))) selectTab(state.presets[sourceIndex + 1].id);
  });
  mk('←', '左移', index === 0, false, () => applyMutation(movePreset(state, preset.id, -1)));
  mk('→', '右移', index === last, false, () => applyMutation(movePreset(state, preset.id, +1)));
  mk('✕', '删除此预设', false, true, () => askDelete(preset.id));
  return ops;
}

function renderTabs() {
  const bar = $('#preset-tabs');
  bar.replaceChildren();
  const last = state.presets.length - 1;
  state.presets.forEach((preset, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `ps-tab${preset.id === editingId ? ' on' : ''}`;
    const name = document.createElement('span');
    name.className = 'ps-tab-name';
    name.textContent = preset.name;
    tab.append(name);
    if (preset.id === state.defaultPresetId) {
      const badge = document.createElement('span');
      badge.className = 'ps-tab-badge';
      badge.textContent = '默认';
      tab.append(badge);
    }
    if (preset.id === editingId) tab.append(inlineOps(preset, index, last));
    tab.addEventListener('click', (event) => {
      if (event.target.closest('.pc-tab-op')) return;
      if (preset.id !== editingId) selectTab(preset.id);
    });
    bar.append(tab);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ps-tab ps-tab-add';
  add.textContent = '＋ 新建';
  add.addEventListener('click', () => {
    if (applyMutation(addPreset(state))) {
      selectTab(state.presets[state.presets.length - 1].id);
      toast('已新建预设，正在编辑 — 记得设置保存目标。', 'success');
    }
  });
  bar.append(add);
}

function selectTab(id) {
  editingId = id;
  closePicker();
  renderTabs();
  syncEditor();
}

// ——— 删除确认对话框：✕ 不直接删，先确认（误触代价高） ———
function askDelete(id) {
  if (state.presets.length <= 1) { toast('无法删除：至少保留一套预设。', 'error'); return; }
  confirmDeleteId = id;
  renderDialog();
}

function renderDialog() {
  const root = $('#dialog-root');
  root.replaceChildren();
  const preset = state.presets.find((candidate) => candidate.id === confirmDeleteId);
  if (!preset) { confirmDeleteId = null; return; }

  const mask = document.createElement('div');
  mask.className = 'ps-dialog-mask';
  mask.addEventListener('click', cancelDelete);

  const dialog = document.createElement('div');
  dialog.className = 'ps-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const title = document.createElement('div');
  title.className = 'ps-dialog-title';
  title.textContent = `删除预设「${preset.name}」？`;
  const body = document.createElement('div');
  body.className = 'ps-dialog-body';
  body.textContent = '此操作不可撤销，预设的模板与 triggers 规则将一并删除。';

  const actions = document.createElement('div');
  actions.className = 'ps-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ps-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', cancelDelete);
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'ps-btn danger-jelly';
  confirm.textContent = '删除';
  confirm.addEventListener('click', () => {
    const id = confirmDeleteId;
    confirmDeleteId = null;
    renderDialog();
    if (applyMutation(removePreset(state, id))) toast(`已删除「${preset.name}」，切换到第一套预设。`);
  });
  actions.append(cancel, confirm);
  dialog.append(title, body, actions);
  root.append(mask, dialog);
}

function cancelDelete() {
  confirmDeleteId = null;
  renderDialog();
}

// ——— 编辑表单 ———
const EDITOR_LABELS = {
  saveSpace: '将该知识库根层设为该预设目标',
  saveNode: '设为该预设的保存目标',
  saving: '正在验证并保存…',
};

function pickerElements() {
  return {
    status: $('#picker-status'),
    list: $('#picker-list'),
    crumbs: $('#crumbs'),
    more: $('#picker-more'),
    back: $('#picker-back'),
    retry: $('#picker-retry'),
    save: $('#picker-save'),
  };
}

function syncEditor() {
  const preset = editingPreset();
  if (!preset) return;
  $('#f-name').value = preset.name;
  $('#f-target-text').textContent = describeDestination(preset.destination);
  // 图标随目标类型切换（知识库 / 文档节点），与弹窗 chip 一致
  $('#f-target-icon').textContent = preset.destination?.kind === 'node' ? '📁' : '🗂';
  const imagesOn = preset.includeImages !== false;
  $('#f-images').classList.toggle('on', imagesOn);
  $('#f-images').setAttribute('aria-pressed', String(imagesOn));
  $('#f-title').value = preset.titleTemplate ?? '';
  $('#f-body').value = preset.bodyTemplate ?? '';
  for (const option of document.querySelectorAll('#f-action .ps-seg-opt')) {
    option.classList.toggle('on', option.dataset.value === preset.action);
  }
  syncTriggersField();
}

// 有非法草稿时恢复草稿与错误（不被已保存的合法值覆盖）
function syncTriggersField() {
  const preset = editingPreset();
  if (!preset) return;
  const draft = triggerDrafts.get(editingId);
  $('#f-triggers').value = draft ?? (preset.triggers ?? []).join('\n');
  if (draft !== undefined) showTriggerErrors(validateTriggers(draft));
  else clearTriggerErrors();
}

// 保存目标选择器：点「更改 ›」在 chip 下方展开面板（chip 保持可见，两者视觉上连成一组），
// 每次展开新建控制器（状态全新；确认只验证不直接写存储）
async function openPicker() {
  $('#picker-panel').classList.remove('hidden');
  picker = createPopupPicker({
    listSpaces: ({ cursor, limit }) => message({ type: 'LIST_SPACES', cursor, limit }),
    listNodes: ({ spaceId, parentNodeToken, cursor, limit }) => message({ type: 'LIST_NODES', spaceId, parentNodeToken, cursor, limit }),
    validateDestination: (candidate) => message({ type: 'VALIDATE_DESTINATION', destination: candidate }),
    initialDestination: editingPreset()?.destination ?? null,
  });
  const els = pickerElements();
  picker.subscribe((pickerState) => renderPicker(picker, pickerState, els, EDITOR_LABELS));
  wirePicker(picker, els);
  await picker.start();
}

function closePicker() {
  $('#picker-panel').classList.add('hidden');
  picker = null;
}

// 选择器/手动输入验证成功后，目标写入当前预设并整体持久化
function applyDestination(destination) {
  if (!editingId || !destination) return;
  applyMutation(updatePreset(state, editingId, { destination }));
  syncEditor();
  closePicker();
}

$('#f-target').addEventListener('click', () => {
  if ($('#picker-panel').classList.contains('hidden')) openPicker();
  else closePicker();
});

// ——— triggers 校验：标红非法行 + 提示行号 + 阻止保存（草稿留内存） ———
function clearTriggerErrors() {
  $('#trigger-errors').replaceChildren();
  $('#trigger-errors').classList.add('hidden');
  $('#f-triggers').classList.remove('invalid');
}

function showTriggerErrors(errors) {
  const box = $('#trigger-errors');
  box.replaceChildren();
  for (const error of errors) {
    const line = document.createElement('div');
    line.className = 'line-error';
    line.textContent = `第 ${error.line} 行：${error.reason}（${error.text}）`;
    box.append(line);
  }
  box.classList.remove('hidden');
  $('#f-triggers').classList.add('invalid');
}

$('#f-triggers').addEventListener('input', () => {
  const text = $('#f-triggers').value;
  const errors = validateTriggers(text);
  if (errors.length > 0) {
    triggerDrafts.set(editingId, text);
    showTriggerErrors(errors);
    toast(`Triggers 有 ${errors.length} 条非法规则，已阻止保存。`, 'error');
    return;
  }
  triggerDrafts.delete(editingId);
  clearTriggerErrors();
  applyMutation(updatePreset(state, editingId, { triggers: parseTriggers(text) }), { quiet: true });
});

// ——— 表单字段：改动即保存 ———
// 名称即时重命名并刷新 tab 标签；失焦时若为空则回退原名
$('#f-name').addEventListener('input', () => {
  const name = $('#f-name').value.trim();
  if (name) applyMutation(renamePreset(state, editingId, name), { quiet: true });
});
$('#f-name').addEventListener('change', () => {
  if (!$('#f-name').value.trim()) $('#f-name').value = editingPreset()?.name ?? '';
});
$('#f-images').addEventListener('click', () => {
  const preset = editingPreset();
  if (preset) applyMutation(updatePreset(state, editingId, { includeImages: preset.includeImages === false }));
  syncEditor();
});
$('#f-title').addEventListener('input', () => {
  applyMutation(updatePreset(state, editingId, { titleTemplate: $('#f-title').value }), { quiet: true });
});
$('#f-body').addEventListener('input', () => {
  applyMutation(updatePreset(state, editingId, { bodyTemplate: $('#f-body').value }), { quiet: true });
});
for (const option of document.querySelectorAll('#f-action .ps-seg-opt')) {
  option.addEventListener('click', () => {
    applyMutation(updatePreset(state, editingId, { action: option.dataset.value }));
    syncEditor();
  });
}

// 变量快捷插入：在光标处插入 {{xxx}}，并沿用字段自身的保存路径
for (const row of document.querySelectorAll('.ps-vars')) {
  const field = $(`#${row.dataset.field}`);
  for (const name of TEMPLATE_VARIABLES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ps-var';
    button.textContent = `{{${name}}}`;
    button.addEventListener('click', () => {
      const inserted = insertVariable(field.value, field.selectionStart ?? field.value.length, name);
      field.value = inserted.text;
      field.focus();
      field.setSelectionRange(inserted.cursor, inserted.cursor);
      field.dispatchEvent(new Event('input'));
    });
    row.append(button);
  }
}

// ——— 选择器保存与手动输入 ———
$('#picker-save').addEventListener('click', async () => {
  if (!picker) return;
  const saved = await picker.saveSelection();
  if (saved) toast(`目标已保存：${describeDestination(saved)}`, 'success');
  else toast(`保存失败：${picker.getState().error?.message || '请重试'}`, 'error');
  applyDestination(saved);
});
$('#save-target').addEventListener('click', async () => {
  if (!picker) return;
  const nodeToken = $('#token').value.trim();
  const spaceId = $('#space').value.trim() || undefined;
  if (!nodeToken && !spaceId) { toast('请填写 Wiki 节点 token 或空间 ID。', 'error'); return; }
  const saved = nodeToken
    ? await picker.saveManual({ kind: 'node', nodeToken, spaceId })
    : await picker.saveManual({ kind: 'space', spaceId });
  if (saved) toast(`目标已保存：${describeDestination(saved)}`, 'success');
  else toast(`目标验证失败：${picker.getState().error?.message || '请重试'}`, 'error');
  applyDestination(saved);
});

// ——— Bridge 配对：已配对显示状态条，未配对/离线显示配对表单（语义色不变） ———
$('#pair').addEventListener('click', async () => {
  try {
    await message({ type: 'PAIR', code: $('#code').value.trim() });
    $('#code').value = '';
    show('配对成功。长期凭据仅保存在扩展的可信上下文中。', 'success');
    location.reload();
  } catch (error) {
    show(`配对失败：${error.message}`, 'error');
  }
});
$('#re-pair').addEventListener('click', () => {
  $('#bridge-ok').classList.add('hidden');
  $('#pair-form').classList.remove('hidden');
});

async function initBridge() {
  try {
    const status = await message({ type: 'STATUS' });
    $('#bridge-ok-text').textContent = `已配对 · Bridge ${status.version} 运行中`;
    $('#bridge-ok').classList.remove('hidden');
    $('#pair-form').classList.add('hidden');
    if (!status.larkAuth?.ready) show('Bridge 已连接，请在终端完成 lark-cli 用户登录。', 'error');
  } catch (error) {
    $('#bridge-ok').classList.add('hidden');
    $('#pair-form').classList.remove('hidden');
    show(error.code === 'BRIDGE_OFFLINE' ? '本地 Bridge 未运行，请启动服务后重试。' : '扩展尚未与本地 Bridge 配对，请粘贴配对码完成配对。', 'error');
  }
}

async function init() {
  const settings = await message({ type: 'GET_SETTINGS' });
  state = { presets: settings.presets ?? [], defaultPresetId: settings.defaultPresetId ?? null };
  editingId = state.defaultPresetId ?? state.presets[0]?.id ?? null;
  renderTabs();
  syncEditor();
  initBridge();
}

init();
