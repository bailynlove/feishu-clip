// 设置页（#35）：预设列表管理 + 预设编辑表单。归约逻辑全在 options-state.js（纯函数），
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

function show(text, kind = 'info') {
  $('#status').textContent = text;
  $('#status').className = `status ${kind}`;
}

// ——— 页面状态：presets/defaultPresetId 与存储一致；editingId 是当前打开表单的预设 ———
let options = { presets: [], defaultPresetId: null };
let editingId = null;
let picker = null;
// triggers 校验失败时阻止保存：暂存未持久化的 textarea 内容，修复前其他字段照常保存
let triggersDirty = false;

async function persist() {
  const saved = await message({ type: 'SAVE_PRESETS', presets: options.presets, defaultPresetId: options.defaultPresetId });
  options = { ...options, ...saved };
  show('已保存。', 'success');
}

function editingPreset() {
  return options.presets.find((preset) => preset.id === editingId) ?? null;
}

function applyMutation(next) {
  if (!next) return false;
  options = next;
  if (editingId && !editingPreset()) closeEditor();
  renderList();
  syncCurrentDestination();
  persist().catch((error) => show(`保存失败：${error.message}`, 'error'));
  return true;
}

function syncCurrentDestination() {
  const current = options.presets.find((preset) => preset.id === options.defaultPresetId) ?? options.presets[0];
  $('#current-destination').textContent = describeDestination(current?.destination);
}

// ——— 预设列表 ———
function renderList() {
  const list = $('#preset-list');
  list.replaceChildren();
  const lastOne = options.presets.length <= 1;
  options.presets.forEach((preset, index) => {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'preset-row';

    const name = document.createElement('input');
    name.className = 'preset-name';
    name.value = preset.name;
    name.title = '重命名';
    name.addEventListener('change', () => {
      applyMutation(renamePreset(options, preset.id, name.value.trim() || preset.name));
      syncEditor();
    });
    row.append(name);

    const summary = document.createElement('span');
    summary.className = 'row-hint preset-summary';
    summary.textContent = describeDestination(preset.destination);
    row.append(summary);

    if (preset.id === options.defaultPresetId) {
      const badge = document.createElement('span');
      badge.className = 'preset-default-badge';
      badge.textContent = '默认';
      row.append(badge);
    }

    const buttons = document.createElement('span');
    buttons.className = 'preset-actions';
    const addButton = (text, title, onClick, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.textContent = text;
      button.title = title;
      button.disabled = disabled;
      button.addEventListener('click', onClick);
      buttons.append(button);
    };
    addButton('编辑', '编辑该预设', () => openEditor(preset.id));
    addButton('复制', '复制该预设', () => applyMutation(duplicatePreset(options, preset.id)));
    addButton('上移', '上移', () => applyMutation(movePreset(options, preset.id, -1)), index === 0);
    addButton('下移', '下移', () => applyMutation(movePreset(options, preset.id, +1)), index === options.presets.length - 1);
    addButton('删除', lastOne ? '至少保留一套预设' : '删除该预设', () => applyMutation(removePreset(options, preset.id)), lastOne);
    addButton('设为默认', '设为默认预设', () => applyMutation(setDefaultPreset(options, preset.id)), preset.id === options.defaultPresetId);
    row.append(buttons);

    item.append(row);
    list.append(item);
  });
}

// ——— 预设编辑表单 ———
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
  $('#f-destination').textContent = describeDestination(preset.destination);
  $('#f-images').checked = preset.includeImages !== false;
  $('#f-title').value = preset.titleTemplate ?? '';
  $('#f-body').value = preset.bodyTemplate ?? '';
  for (const radio of document.querySelectorAll('input[name="f-action"]')) radio.checked = radio.value === preset.action;
  if (!triggersDirty) $('#f-triggers').value = (preset.triggers ?? []).join('\n');
}

async function openEditor(id) {
  editingId = id;
  triggersDirty = false;
  $('#preset-editor').classList.remove('hidden');
  syncEditor();
  clearTriggerErrors();

  // 每次打开都新建控制器：状态全新，目标初值为该预设当前目标；确认只验证不直接写存储
  picker = createPopupPicker({
    listSpaces: ({ cursor, limit }) => message({ type: 'LIST_SPACES', cursor, limit }),
    listNodes: ({ spaceId, parentNodeToken, cursor, limit }) => message({ type: 'LIST_NODES', spaceId, parentNodeToken, cursor, limit }),
    validateDestination: (candidate) => message({ type: 'VALIDATE_DESTINATION', destination: candidate }),
    initialDestination: editingPreset()?.destination ?? null,
  });
  const els = pickerElements();
  picker.subscribe((state) => renderPicker(picker, state, els, EDITOR_LABELS));
  wirePicker(picker, els);
  await picker.start();
  $('#preset-editor').scrollIntoView();
}

function closeEditor() {
  editingId = null;
  picker = null;
  $('#preset-editor').classList.add('hidden');
}

// 选择器/手动输入验证成功后，目标写入当前编辑的预设并整体持久化
function applyDestination(destination) {
  if (!editingId || !destination) return;
  applyMutation(updatePreset(options, editingId, { destination }));
  syncEditor();
}

// ——— triggers 校验：标红非法行 + 提示行号 + 阻止保存 ———
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
    triggersDirty = true;
    showTriggerErrors(errors);
    show(`Triggers 有 ${errors.length} 条非法规则，已阻止保存。`, 'error');
    return;
  }
  triggersDirty = false;
  clearTriggerErrors();
  applyMutation(updatePreset(options, editingId, { triggers: parseTriggers(text) }));
});

// ——— 表单字段：改动即保存 ———
$('#f-name').addEventListener('change', () => {
  const preset = editingPreset();
  if (preset) applyMutation(renamePreset(options, editingId, $('#f-name').value.trim() || preset.name));
});
$('#f-images').addEventListener('change', () => {
  applyMutation(updatePreset(options, editingId, { includeImages: $('#f-images').checked }));
});
$('#f-title').addEventListener('input', () => {
  applyMutation(updatePreset(options, editingId, { titleTemplate: $('#f-title').value }));
});
$('#f-body').addEventListener('input', () => {
  applyMutation(updatePreset(options, editingId, { bodyTemplate: $('#f-body').value }));
});
for (const radio of document.querySelectorAll('input[name="f-action"]')) {
  radio.addEventListener('change', () => {
    if (radio.checked) applyMutation(updatePreset(options, editingId, { action: radio.value }));
  });
}
$('#editor-done').addEventListener('click', closeEditor);

// 变量快捷插入：在光标处插入 {{xxx}}，并沿用字段自身的保存路径
for (const row of document.querySelectorAll('.var-row')) {
  const field = $(`#${row.dataset.field}`);
  for (const name of TEMPLATE_VARIABLES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link var-btn';
    button.textContent = name;
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
  if (saved) show(`目标已保存：${describeDestination(saved)}`, 'success');
  else show(`保存失败：${picker.getState().error?.message || '请重试'}`, 'error');
  applyDestination(saved);
});
$('#save-target').addEventListener('click', async () => {
  if (!picker) return;
  const nodeToken = $('#token').value.trim();
  const spaceId = $('#space').value.trim() || undefined;
  if (!nodeToken && !spaceId) { show('请填写 Wiki 节点 token 或空间 ID。', 'error'); return; }
  const saved = nodeToken
    ? await picker.saveManual({ kind: 'node', nodeToken, spaceId })
    : await picker.saveManual({ kind: 'space', spaceId });
  if (saved) show(`目标已保存：${describeDestination(saved)}`, 'success');
  else show(`目标验证失败：${picker.getState().error?.message || '请重试'}`, 'error');
  applyDestination(saved);
});

// ——— 列表操作与初始化 ———
$('#preset-add').addEventListener('click', () => {
  if (applyMutation(addPreset(options))) openEditor(options.presets[options.presets.length - 1].id);
});

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

async function init() {
  const settings = await message({ type: 'GET_SETTINGS' });
  options = { presets: settings.presets ?? [], defaultPresetId: settings.defaultPresetId ?? null };
  renderList();
  syncCurrentDestination();
}

init();
