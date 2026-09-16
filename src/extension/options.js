// 设置页（#35）：标签页式预设管理（C 版设计）。归约逻辑全在 options-state.js（纯函数），
// 本文件只负责 DOM 渲染与 chrome 消息。所有变更经 SAVE_PRESETS 整体写回持久化。
import { createPopupPicker } from './popup-picker.js';
import { createDrivePicker } from './drive-picker.js';
import { describeDestination, renderPicker, wirePicker, renderDrivePicker, wireDrivePicker } from './picker-view.js';
import {
  addPreset, duplicatePreset, movePreset, removePreset, renamePreset, setDefaultPreset, updatePreset,
  validateTriggers, parseTriggers, insertVariable, variableRowNames, digestFileHintNeeded,
  TRIGGER_PRESETS_KEY, mergeBuiltInTriggerPresets, addTriggerPreset, removeTriggerPreset, appendTriggerRule,
  jobStatusTone, jobStatusLabel, jobTotalLabel, jobDisplayTitle, formatClock, jobDetailRows,
  imageModeHint,
  AI_API_TYPE_OPTIONS, aiDefaultBaseUrl, aiConfigPayload, aiDigestProviderOptions, aiHeadersToText, aiProviderByName, aiTestResultView,
  COLLAPSIBLE_SECTIONS, DEFAULT_AI_PROVIDER_NAME, OPTIONS_COLLAPSE_KEY, normalizeCollapsedSections, resolveAiProviderSelection, setSectionCollapsed,
} from './options-state.js';
import { createDriveFolder, DEFAULT_DIGEST_DOC_TITLE, DEFAULT_DIGEST_INSTRUCTION, readDigestConfig, readPdfDriveConfig, resolveImageMode, resolvePdfDrive } from './presets.js';
import { createProxySettingsController } from './options-proxy.js';
import { parsePdfTranslatorFile } from './pdf-translator.js';
import { PDF_TRANSLATORS_STORAGE_KEY, normalizePdfTranslatorEntries, pdfTranslatorView, removePdfTranslator, setPdfTranslatorEnabled, upsertPdfTranslator } from './pdf-translator-store.js';

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
let drivePicker = null;
let confirmDeleteId = null;
// triggers 校验失败时阻止保存：非法草稿按预设 id 留在内存里，切回该预设的 tab 时恢复并继续
// 报错，修复合法写回成功后清除。内存态即可，重开设置页页面后丢弃。
const triggerDrafts = new Map();

let saveToastTimer = null;
async function persist(quiet = false) {
  const saved = await message({ type: 'SAVE_PRESETS', presets: state.presets, defaultPresetId: state.defaultPresetId });
  state = { ...state, ...saved };
  if (!quiet) { toast('已保存 ✓', 'success'); return; }
  // 文本框逐键保存不逐键打扰：停顿 1 秒后汇总弹一次「已保存」
  clearTimeout(saveToastTimer);
  saveToastTimer = setTimeout(() => toast('已保存 ✓', 'success'), 1000);
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
    closeDrivePicker();
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
  closeDrivePicker();
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
  const imageMode = resolveImageMode(preset);
  for (const option of document.querySelectorAll('#f-image-mode .ps-seg-opt')) {
    option.classList.toggle('on', option.dataset.value === imageMode);
  }
  $('#f-image-mode-hint').textContent = imageModeHint(imageMode);
  // PDF 存云盘开关（#65）：读取原始配置回填——开关只折叠不清空（#100），关闭态也读得出
  // 已选目录；目录行（#66）开关开启才显示；folderToken 为 null 即云盘根目录，folderName 冗余存展示名
  const pdfDrive = readPdfDriveConfig(preset);
  const pdfEnabled = pdfDrive?.enabled === true;
  $('#f-pdf-drive').classList.toggle('on', pdfEnabled);
  $('#f-pdf-drive').setAttribute('aria-pressed', String(pdfEnabled));
  $('#f-pdf-drive-body').classList.toggle('hidden', !pdfEnabled);
  $('#f-pdf-folder').classList.toggle('hidden', !pdfEnabled);
  $('#f-pdf-folder-text').textContent = pdfDrive?.folderToken ? (pdfDrive.folderName ?? pdfDrive.folderToken) : '云盘根目录（我的空间）';
  if (!pdfEnabled) closeDrivePicker();
  // AI 摘要（#75）：开关 = 折叠/展开设置区，关闭不清空内容——回填走 readDigestConfig
  // （关闭态也读得出已存指令/provider/mode），运行时判定才走 resolveDigest。
  // provider 选用行（#78；选项随 bridge 列表重建，悬空引用补「已删除」幽灵项）。
  // 呈现方式分段（#98）：开启才显示；子文档标题模板行仅 subdoc 显示
  const digest = readDigestConfig(preset);
  const digestEnabled = digest?.enabled === true;
  $('#f-digest').classList.toggle('on', digestEnabled);
  $('#f-digest').setAttribute('aria-pressed', String(digestEnabled));
  $('#f-digest-body').classList.toggle('hidden', !digestEnabled);
  $('#f-digest-instruction-row').classList.toggle('hidden', !digestEnabled);
  $('#f-digest-provider-row').classList.toggle('hidden', !digestEnabled);
  $('#f-digest-mode-row').classList.toggle('hidden', !digestEnabled);
  const digestMode = digest?.mode ?? 'subdoc';
  for (const option of document.querySelectorAll('#f-digest-mode .ps-seg-opt')) {
    option.classList.toggle('on', option.dataset.value === digestMode);
  }
  $('#f-digest-doctitle-row').classList.toggle('hidden', !digestEnabled || digestMode !== 'subdoc');
  $('#f-digest-doctitle').value = digest?.docTitleTemplate ?? '';
  $('#f-digest-instruction').value = digest?.instruction ?? '';
  syncDigestFileHint();
  renderDigestProviderOptions();
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

// ——— PDF 云盘目录 picker（#66）：与 wiki 目标同一面板形态，数据源是 drive 端点族；
// 确认只验证不落库，目录随预设整体经 SAVE_PRESETS 写回 ———
const DRIVE_EDITOR_LABELS = {
  saveRoot: '将该预设的 PDF 存到云盘根目录',
  saveFolder: '设为该预设的 PDF 目录',
  saving: '正在验证并保存…',
};

function drivePickerElements() {
  return {
    status: $('#dp-status'),
    list: $('#dp-list'),
    crumbs: $('#dp-crumbs'),
    more: $('#dp-more'),
    back: $('#dp-back'),
    retry: $('#dp-retry'),
    save: $('#dp-save'),
  };
}

async function openDrivePicker() {
  $('#drive-picker-panel').classList.remove('hidden');
  const current = resolvePdfDrive(editingPreset());
  drivePicker = createDrivePicker({
    listFolders: ({ folderToken, cursor, limit }) => message({ type: 'LIST_DRIVE_FOLDERS', folderToken, cursor, limit }),
    validateFolder: async ({ folderToken }) => (await message({ type: 'VALIDATE_DRIVE_FOLDER', folderToken })).folder,
    initialDestination: current ? { folderToken: current.folderToken, title: current.folderName ?? '我的空间' } : null,
  });
  const els = drivePickerElements();
  drivePicker.subscribe((pickerState) => renderDrivePicker(drivePicker, pickerState, els, DRIVE_EDITOR_LABELS));
  wireDrivePicker(drivePicker, els);
  await drivePicker.start();
}

function closeDrivePicker() {
  $('#drive-picker-panel').classList.add('hidden');
  drivePicker = null;
}

// 选择器/手贴 token 验证成功后，目录写入当前预设的 pdfDrive 并整体持久化
function applyPdfDrive(saved) {
  if (!editingId || !saved) return;
  applyMutation(updatePreset(state, editingId, {
    pdfDrive: { enabled: true, ...createDriveFolder({ folderToken: saved.folderToken, folderName: saved.title }) },
  }));
  syncEditor();
  closeDrivePicker();
}

$('#f-pdf-folder').addEventListener('click', () => {
  if ($('#drive-picker-panel').classList.contains('hidden')) openDrivePicker();
  else closeDrivePicker();
});

$('#dp-save').addEventListener('click', async () => {
  if (!drivePicker) return;
  const saved = await drivePicker.saveSelection();
  if (saved) toast(`PDF 目录已保存：${saved.title}`, 'success');
  else toast(`保存失败：${drivePicker.getState().error?.message || '请重试'}`, 'error');
  applyPdfDrive(saved);
});

// 手贴 token（高级设置）：留空 = 云盘根目录；与可视化选择同一验证语义，失败不覆盖旧目录
$('#save-drive-target').addEventListener('click', async () => {
  if (!drivePicker) return;
  const folderToken = $('#drive-token').value.trim() || null;
  const saved = await drivePicker.saveManual({ folderToken, title: folderToken ?? '我的空间', path: folderToken ? undefined : ['我的空间'] });
  if (saved) toast(`PDF 目录已保存：${saved.title}`, 'success');
  else toast(`目录验证失败：${drivePicker.getState().error?.message || '请重试'}`, 'error');
  applyPdfDrive(saved);
});

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

// 触发文本的统一入口：校验 → 非法存草稿并阻止保存 / 合法清草稿并落预设（气泡追加与手输共用）
function applyTriggersText(text) {
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
}

$('#f-triggers').addEventListener('input', () => applyTriggersText($('#f-triggers').value));

// ——— 触发规则预设气泡（#101）：全局键 triggerPresets 直读直写 chrome.storage.local
// （读取未搭 GET_SETTINGS 便车；写入与 aiDigestInstruction 同为 options 页直写）；
// 内存 triggerPresets 是唯一事实源，变更后整体写回 ———
let triggerPresets = [];

function renderTriggerPresets() {
  const box = $('#trigger-presets');
  box.textContent = '';
  if (triggerPresets.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'trigger-empty';
    hint.textContent = '暂无预设，点击气泡可把规则追加到下方输入框';
    box.append(hint);
    return;
  }
  for (const preset of triggerPresets) {
    const chip = document.createElement('span');
    chip.className = 'trigger-chip';
    const appendBtn = document.createElement('button');
    appendBtn.className = 'trigger-chip-add';
    appendBtn.type = 'button';
    appendBtn.textContent = preset.name;
    appendBtn.title = preset.rule;
    appendBtn.addEventListener('click', () => {
      $('#f-triggers').value = appendTriggerRule($('#f-triggers').value, preset.rule);
      applyTriggersText($('#f-triggers').value);
    });
    chip.append(appendBtn);
    // 内置预设（builtin- 前缀，#95 paper）不给删除入口
    if (!preset.id.startsWith('builtin-')) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'trigger-chip-x';
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('aria-label', `删除预设 ${preset.name}`);
      removeBtn.addEventListener('click', async () => {
        triggerPresets = removeTriggerPreset(triggerPresets, preset.id);
        await chrome.storage.local.set({ [TRIGGER_PRESETS_KEY]: triggerPresets });
        renderTriggerPresets();
      });
      chip.append(removeBtn);
    }
    box.append(chip);
  }
}

// 保存为新预设：规则取当前 triggers 输入框内容（可多行——一个预设可携带一组规则，点击追加时
// 一行一条落进输入框，为 #95 的站点清单预设铺路）；名称/规则空或重名拒绝（addTriggerPreset 返回 null）
$('#trigger-preset-save').addEventListener('click', () => {
  $('#trigger-preset-form').classList.remove('hidden');
  $('#trigger-preset-name').focus();
});
$('#trigger-preset-cancel').addEventListener('click', () => {
  $('#trigger-preset-form').classList.add('hidden');
  $('#trigger-preset-name').value = '';
});
$('#trigger-preset-confirm').addEventListener('click', async () => {
  const next = addTriggerPreset(triggerPresets, { name: $('#trigger-preset-name').value, rule: $('#f-triggers').value });
  if (!next) {
    toast('保存失败：名称与规则都不能为空，且名称不能重复。', 'error');
    return;
  }
  triggerPresets = next;
  await chrome.storage.local.set({ [TRIGGER_PRESETS_KEY]: triggerPresets });
  $('#trigger-preset-form').classList.add('hidden');
  $('#trigger-preset-name').value = '';
  renderTriggerPresets();
  toast('已保存为规则预设。', 'success');
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
for (const option of document.querySelectorAll('#f-image-mode .ps-seg-opt')) {
  option.addEventListener('click', () => {
    applyMutation(updatePreset(state, editingId, { imageMode: option.dataset.value }));
    syncEditor();
  });
}
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
// PDF 存云盘开关（#65）：开关 = 折叠/展开设置区，与 AI 摘要开关同语义（#100）——切换只翻转
// enabled 标志，已选目录 folderToken/folderName 保留；folderToken null = 云盘根目录（目录选择
// 见 #66 的目录行/picker）；随预设整体经 SAVE_PRESETS 写回
$('#f-pdf-drive').addEventListener('click', () => {
  const current = readPdfDriveConfig(editingPreset());
  applyMutation(updatePreset(state, editingId, {
    pdfDrive: { enabled: !(current?.enabled === true), ...createDriveFolder(current ?? {}) },
  }));
  syncEditor();
});

// AI 摘要预设开关（#75）：开关 = 折叠/展开设置区，与弹窗的临时摘要开关同语义——切换只翻转
// enabled 标志，instruction/provider/mode/docTitleTemplate 全部保留，不再归一为 null；
// 随预设整体经 SAVE_PRESETS 写回
$('#f-digest').addEventListener('click', () => {
  const current = readDigestConfig(editingPreset());
  applyMutation(updatePreset(state, editingId, {
    digest: {
      enabled: !(current?.enabled === true),
      instruction: current?.instruction ?? '',
      provider: current?.provider ?? '',
      mode: current?.mode ?? 'subdoc',
      docTitleTemplate: current?.docTitleTemplate ?? DEFAULT_DIGEST_DOC_TITLE,
    },
  }));
  syncEditor();
});
// digest 单字段更新（#98）：从当前预设已存配置展开覆盖单字段，保住 mode/docTitleTemplate 等兄弟字段
function patchDigest(patch) {
  const current = readDigestConfig(editingPreset());
  applyMutation(updatePreset(state, editingId, {
    digest: {
      enabled: true,
      instruction: current?.instruction ?? '',
      provider: current?.provider ?? '',
      mode: current?.mode ?? 'subdoc',
      docTitleTemplate: current?.docTitleTemplate ?? DEFAULT_DIGEST_DOC_TITLE,
      ...patch,
    },
  }), { quiet: true });
}
// {{@file}} 行内提示（#81）：指令含 {{@file}} 但预设未开「PDF 存云盘」时显示；只提示不阻止保存
function syncDigestFileHint() {
  const pdfEnabled = resolvePdfDrive(editingPreset())?.enabled === true;
  $('#f-digest-file-hint').classList.toggle('hidden', !digestFileHintNeeded($('#f-digest-instruction').value, pdfEnabled));
}

$('#f-digest-instruction').addEventListener('input', () => {
  patchDigest({ instruction: $('#f-digest-instruction').value });
  syncDigestFileHint();
});

// provider 选用（#78）：下拉值即 provider 名（'' = 默认 provider），随预设整体写回
$('#f-digest-provider').addEventListener('change', () => {
  patchDigest({ provider: $('#f-digest-provider').value });
});

// 呈现方式分段（#98）：切换后同步编辑器（子文档标题行仅 subdoc 显示）
for (const option of document.querySelectorAll('#f-digest-mode .ps-seg-opt')) {
  option.addEventListener('click', () => {
    patchDigest({ mode: option.dataset.value });
    syncEditor();
  });
}
// 子文档标题模板（#98）：留空回落默认标题 Digest（回落在 resolveDigest/background 各层同口径）
$('#f-digest-doctitle').addEventListener('input', () => {
  patchDigest({ docTitleTemplate: $('#f-digest-doctitle').value });
});

// provider 下拉选项重建（bridge 列表变化后调用）：保留当前选中；预设引用了已删除的
// provider 时补一个「（已删除）」幽灵项，避免选择被静默改写
function renderDigestProviderOptions() {
  const select = $('#f-digest-provider');
  const current = readDigestConfig(editingPreset())?.provider ?? '';
  const options = aiDigestProviderOptions(aiProviders);
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: `${current}（已删除）` });
  }
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
  select.value = current;
  // bridge 列表拿不到时下拉只剩「默认」一项，给出降级提示而非静默只剩一个选项
  $('#f-digest-provider-hint').classList.toggle('hidden', aiProvidersReady);
}

// 变量快捷插入：在光标处插入 {{xxx}}，并沿用字段自身的保存路径；
// 按钮名单默认 TEMPLATE_VARIABLES，行上 data-vars 显式指定时优先（#81 摘要指令框只列 @file）
for (const row of document.querySelectorAll('.ps-vars')) {
  const field = $(`#${row.dataset.field}`);
  for (const name of variableRowNames(row.dataset.vars)) {
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

// ——— AI provider 预设（#77）：多套命名配置存 bridge 的 ai.json（key 不落 chrome.storage），
// 列表/保存/删除/测试都经 background 代理端点；全局摘要指令是单键配置，直写 chrome.storage.local
// （与 developerMode 同一先例）。本段只做 DOM 接线，归约逻辑在 options-state.js ———
let aiProviders = []; // bridge 列表（sanitized，只回 hasKey 不回 key）
let aiSelected = null; // 当前编辑的 provider 名；null = 新建草稿态（尚未保存）
let aiProvidersReady = false; // 是否成功读到 bridge 列表；false 时预设下拉降级并显示提示（#78）

function showAiResult(view) {
  const node = $('#ai-result');
  node.textContent = view.text;
  node.className = `ps-note ${NOTICE_TONES[view.tone] ?? 'info'}`;
}

function aiFormDraft() {
  return {
    name: $('#ai-name').value,
    apiType: $('#ai-api-type').value,
    baseUrl: $('#ai-base-url').value,
    model: $('#ai-model').value,
    apiKey: $('#ai-api-key').value,
    headersText: $('#ai-headers').value,
    maxOutputTokensText: $('#ai-max-output-tokens').value,
    timeoutText: $('#ai-timeout').value,
    reasoning: $('#ai-reasoning').value,
  };
}

// Base URL 占位符跟随所选 API 类型的默认值（用户已填内容不动）
function syncAiBaseUrlPlaceholder() {
  $('#ai-base-url').placeholder = aiDefaultBaseUrl($('#ai-api-type').value);
}

function syncAiKeyPlaceholder() {
  const hasKey = aiSelected ? aiProviderByName(aiProviders, aiSelected)?.hasKey === true : false;
  $('#ai-api-key').placeholder = hasKey ? '已保存，留空则保持不变' : '';
}

// tabs 沿用预设管理的 ps-tab 模式；「默认」带 badge 且不可删改名的约束在 bridge 端强制
function renderAiTabs() {
  const bar = $('#ai-provider-tabs');
  bar.replaceChildren();
  for (const provider of aiProviders) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `ps-tab${provider.name === aiSelected ? ' on' : ''}`;
    const name = document.createElement('span');
    name.className = 'ps-tab-name';
    name.textContent = provider.name;
    tab.append(name);
    if (provider.name === DEFAULT_AI_PROVIDER_NAME) {
      const badge = document.createElement('span');
      badge.className = 'ps-tab-badge';
      badge.textContent = DEFAULT_AI_PROVIDER_NAME;
      tab.append(badge);
    }
    tab.addEventListener('click', () => {
      if (provider.name !== aiSelected) {
        aiSelected = provider.name;
        renderAiTabs();
        fillAiForm();
      }
    });
    bar.append(tab);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = `ps-tab ps-tab-add${aiSelected === null ? ' on' : ''}`;
  add.textContent = '＋ 新建';
  add.addEventListener('click', () => {
    if (aiSelected !== null) {
      aiSelected = null;
      renderAiTabs();
      fillAiForm();
    }
  });
  bar.append(add);
}

// 表单回填：新建草稿态清空、名称可编辑；已有 provider 回填各字段，「默认」名称锁定
function fillAiForm() {
  const provider = aiSelected ? aiProviderByName(aiProviders, aiSelected) : null;
  $('#ai-name').value = provider?.name ?? '';
  $('#ai-name').disabled = provider?.name === DEFAULT_AI_PROVIDER_NAME;
  $('#ai-api-type').value = provider?.apiType ?? 'responses';
  $('#ai-base-url').value = provider?.baseUrl ?? '';
  $('#ai-model').value = provider?.model ?? '';
  $('#ai-api-key').value = '';
  $('#ai-headers').value = aiHeadersToText(provider?.headers);
  $('#ai-max-output-tokens').value = provider?.maxOutputTokens ? String(provider.maxOutputTokens) : '';
  $('#ai-timeout').value = provider?.timeoutMs ? String(Math.round(provider.timeoutMs / 1000)) : '';
  $('#ai-reasoning').value = provider?.reasoning ?? '';
  $('#ai-delete').classList.toggle('hidden', !provider || provider.name === DEFAULT_AI_PROVIDER_NAME);
  syncAiBaseUrlPlaceholder();
  syncAiKeyPlaceholder();
}

// 拉取列表并解析选中名（被删/首载回落「默认」；空列表 → 新建草稿态）。
// 列表变化同步刷新预设表单的 provider 下拉（#78）
async function reloadAiProviders(selectName = aiSelected) {
  const { providers } = await message({ type: 'LIST_AI_PROVIDERS' });
  aiProviders = providers ?? [];
  aiProvidersReady = true;
  aiSelected = resolveAiProviderSelection(aiProviders, selectName);
  renderAiTabs();
  fillAiForm();
  syncEditor();
}

async function initAiSection(aiDigestInstruction) {
  const typeSelect = $('#ai-api-type');
  for (const option of AI_API_TYPE_OPTIONS) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    typeSelect.append(node);
  }
  syncAiBaseUrlPlaceholder();
  // 全局指令：placeholder 即内置默认指令（留空 = 用默认），已存值原样回填
  $('#ai-instruction').placeholder = DEFAULT_DIGEST_INSTRUCTION;
  $('#ai-instruction').value = typeof aiDigestInstruction === 'string' ? aiDigestInstruction : '';
  // 读取 provider 列表回填；bridge 离线/老版本无端点时保持空表单并提示
  try {
    await reloadAiProviders(null);
  } catch {
    renderAiTabs();
    fillAiForm();
    syncEditor(); // 列表读取失败：预设下拉降级为仅「默认」，渲染出降级提示
    showAiResult({ tone: 'info', text: '未读取到 AI provider 列表（Bridge 未连接或版本过旧）。' });
  }
}

$('#ai-api-type').addEventListener('change', syncAiBaseUrlPlaceholder);

$('#ai-save').addEventListener('click', async () => {
  try {
    const draft = aiFormDraft();
    if (!draft.name.trim()) throw new Error('请填写 provider 名称');
    // 改名：已有非「默认」provider 的名称被改动 → renameFrom 带原名（bridge 搬 key 删旧名）
    const renameFrom = aiSelected && aiSelected !== DEFAULT_AI_PROVIDER_NAME && draft.name.trim() !== aiSelected ? aiSelected : undefined;
    const { provider } = await message({ type: 'SAVE_AI_PROVIDER', provider: aiConfigPayload({ ...draft, renameFrom }) });
    await reloadAiProviders(provider?.name ?? draft.name.trim());
    showAiResult({ tone: 'success', text: 'AI provider 已保存 ✓' });
  } catch (error) {
    showAiResult({ tone: 'error', text: `保存失败：${error.message}` });
  }
});

$('#ai-test').addEventListener('click', async () => {
  showAiResult({ tone: 'info', text: '正在测试连接…' });
  try {
    const overrides = aiConfigPayload({ ...aiFormDraft(), name: undefined });
    // 新建草稿没有已存配置可回落，apiKey 必须现填；已有 provider 走 name + 覆盖合并
    const request = aiSelected ? { name: aiSelected, overrides } : { overrides };
    if (!aiSelected && !overrides.apiKey) throw new Error('新 provider 请先填写 API key 再测试');
    showAiResult(aiTestResultView(await message({ type: 'TEST_AI', ...request })));
  } catch (error) {
    showAiResult({ tone: 'error', text: `连接失败：${error.message}` });
  }
});

$('#ai-delete').addEventListener('click', async () => {
  if (!aiSelected || aiSelected === DEFAULT_AI_PROVIDER_NAME) return;
  const name = aiSelected;
  if (!window.confirm(`删除 provider「${name}」？引用它的预设剪藏时将不再生成摘要（任务会带警告）。`)) return;
  try {
    await message({ type: 'DELETE_AI_PROVIDER', name });
    await reloadAiProviders(null);
    showAiResult({ tone: 'success', text: `provider「${name}」已删除` });
  } catch (error) {
    showAiResult({ tone: 'error', text: `删除失败：${error.message}` });
  }
});

// 全局摘要指令：单键直写（同 developerMode 先例），留空即删除回落到内置默认
$('#ai-instruction').addEventListener('input', async () => {
  await chrome.storage.local.set({ aiDigestInstruction: $('#ai-instruction').value });
});

const proxySettings = createProxySettingsController({ input: $('#proxy-port'), result: $('#proxy-result'), send: message });
$('#proxy-save').addEventListener('click', () => proxySettings.save());

let pdfTranslators = [];
function renderPdfTranslators() {
  const list = $('#pdf-translator-list');
  list.replaceChildren();
  if (!pdfTranslators.length) { list.textContent = '当前没有导入文件。'; return; }
  for (const entry of pdfTranslators) {
    const view = pdfTranslatorView(entry);
    const row = document.createElement('div');
    row.className = 'ps-note';
    const title = document.createElement('strong');
    title.textContent = `${view.label} · ${view.version}`;
    const detail = document.createElement('div');
    detail.textContent = `${view.creator} · priority ${view.priority} · ${view.compatibility} · ${view.enabled ? '启用' : '停用'}${view.requestOrigins.length ? ` · 跨域：${view.requestOrigins.join(', ')}` : ''}`;
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'link'; toggle.textContent = view.enabled ? '停用' : '启用';
    toggle.addEventListener('click', async () => { pdfTranslators = setPdfTranslatorEnabled(pdfTranslators, view.translatorID, !view.enabled); await chrome.storage.local.set({ [PDF_TRANSLATORS_STORAGE_KEY]: pdfTranslators }); renderPdfTranslators(); });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'link'; remove.textContent = '移除';
    remove.addEventListener('click', async () => { if (!window.confirm(`移除 Translator「${view.label}」？`)) return; pdfTranslators = removePdfTranslator(pdfTranslators, view.translatorID); await chrome.storage.local.set({ [PDF_TRANSLATORS_STORAGE_KEY]: pdfTranslators }); renderPdfTranslators(); });
    const source = document.createElement('button');
    source.type = 'button'; source.className = 'link'; source.textContent = '查看/复制源代码';
    source.addEventListener('click', async () => {
      const code = entry.translator?.source || entry.translator?.code || '';
      try { await navigator.clipboard.writeText(code); toast('源代码已复制', 'success'); }
      catch { window.prompt('复制源代码', code); }
    });
    row.append(title, detail, toggle, document.createTextNode(' '), source, document.createTextNode(' '), remove);
    list.append(row);
  }
}
$('#pdf-translator-files').addEventListener('change', async (event) => {
  for (const file of event.target.files || []) {
    try {
      const parsed = parsePdfTranslatorFile(await file.text());
      if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join('；'));
      const view = pdfTranslatorView({ ...parsed, confirmed: true, enabled: true });
      const previous = pdfTranslators.find((item) => item.translator?.metadata?.translatorID === view.translatorID);
      const previousView = previous ? pdfTranslatorView(previous) : null;
      const replacement = previousView ? `\n\n将替换当前版本：${previousView.version} → ${view.version}\n跨域权限：${previousView.requestOrigins.join(', ') || '无'} → ${view.requestOrigins.join(', ') || '无'}` : '';
      if (!window.confirm(`确认导入「${view.label}」？\n作者：${view.creator}\nID：${view.translatorID}\n适用网址：${view.target}\n跨域权限：${view.requestOrigins.join(', ') || '无'}${replacement}`)) continue;
      pdfTranslators = upsertPdfTranslator(pdfTranslators, { ...parsed, confirmed: true, enabled: true });
      await chrome.storage.local.set({ [PDF_TRANSLATORS_STORAGE_KEY]: pdfTranslators });
    } catch (error) { toast(`${file.name} 导入失败：${error.message}`, 'error'); }
  }
  event.target.value = '';
  renderPdfTranslators();
});


// ——— 开发者模式：开关直写 chrome.storage.local（options 页是 trusted context，无需经 background
// 中转；与 SAVE_PRESETS 不同，这是单 key 不涉及归约校验）。任务日志经 LIST_JOBS 从 bridge 读取。 ———
function renderJobLog(jobs) {
  const status = $('#joblog-status');
  const list = $('#joblog-list');
  list.replaceChildren();
  if (!jobs.length) {
    status.textContent = '暂无任务记录';
    return;
  }
  status.textContent = '';
  for (const job of jobs) {
    const item = document.createElement('details');
    item.className = 'joblog-item';
    const summary = document.createElement('summary');
    // 状态点颜色归类（绿/黄/红/蓝）在纯函数里，这里只拼 class
    const dot = document.createElement('span');
    dot.className = `joblog-dot tone-${jobStatusTone(job.status)}`;
    dot.title = jobStatusLabel(job.status);
    const name = document.createElement('span');
    name.className = 'joblog-name';
    name.textContent = jobDisplayTitle(job);
    const total = document.createElement('span');
    total.className = 'joblog-total';
    total.textContent = jobTotalLabel(job);
    const time = document.createElement('span');
    time.className = 'joblog-time';
    time.textContent = formatClock(job.createdAt);
    summary.append(dot, name, total, time);
    item.append(summary);

    const detail = document.createElement('div');
    detail.className = 'joblog-detail';
    const rows = jobDetailRows(job);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'joblog-row';
      empty.textContent = '暂无耗时明细';
      detail.append(empty);
    }
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = `joblog-row indent-${row.indent}${row.failed ? ' failed' : ''}`;
      const label = document.createElement('span');
      label.className = 'joblog-row-label';
      label.textContent = row.label;
      const value = document.createElement('span');
      value.className = 'joblog-row-value';
      value.textContent = row.value;
      line.append(label, value);
      detail.append(line);
    }
    item.append(detail);
    list.append(item);
  }
}

async function loadJobLog() {
  const status = $('#joblog-status');
  status.textContent = '加载中…';
  try {
    const result = await message({ type: 'LIST_JOBS' });
    renderJobLog(result.jobs ?? []);
  } catch {
    // bridge 离线/未配对/老版本无此端点，统一提示未连接（任务日志是诊断功能，不细究原因）
    $('#joblog-list').replaceChildren();
    status.textContent = 'Bridge 未连接，无法读取任务日志';
  }
}

function setDeveloperMode(on) {
  const toggle = $('#devmode-toggle');
  toggle.classList.toggle('on', on);
  toggle.setAttribute('aria-pressed', String(on));
  $('#joblog').classList.toggle('hidden', !on);
  if (on) loadJobLog();
}

$('#devmode-toggle').addEventListener('click', async () => {
  const on = !$('#devmode-toggle').classList.contains('on');
  setDeveloperMode(on);
  await chrome.storage.local.set({ developerMode: on });
});

$('#joblog-refresh').addEventListener('click', () => loadJobLog());

// ——— 分区折叠（#76）：AI 摘要/预设管理两区用原生 details（键盘 Enter/Space 原生可达，
// 收起时子树留在 DOM，未保存的表单值不丢）；open 状态持久化到 chrome.storage.local 单键。
// 内存 collapsed 是唯一事实源：初始化回填触发的 toggle 与存储值相等，直接不落库；
// 处理器同步更新内存再写库，避免 get→set 读改写竞态（两区快速连续 toggle 时丢另一区状态） ———
function initCollapsibleSections(stored) {
  let collapsed = normalizeCollapsedSections(stored);
  for (const { id, key } of COLLAPSIBLE_SECTIONS) {
    const node = $(`#${id}`);
    if (!node) continue;
    node.open = !collapsed[key];
    node.addEventListener('toggle', async () => {
      const next = !node.open;
      if (next === collapsed[key]) return;
      collapsed = setSectionCollapsed(collapsed, key, next);
      await chrome.storage.local.set({ [OPTIONS_COLLAPSE_KEY]: collapsed });
    });
  }
}

async function init() {
  const settings = await message({ type: 'GET_SETTINGS' });
  state = { presets: settings.presets ?? [], defaultPresetId: settings.defaultPresetId ?? null };
  editingId = state.defaultPresetId ?? state.presets[0]?.id ?? null;
  renderTabs();
  syncEditor();
  initBridge();
  initAiSection(settings.aiDigestInstruction);
  initCollapsibleSections(settings.optionsUiCollapsed);
  await proxySettings.load();
  pdfTranslators = normalizePdfTranslatorEntries((await chrome.storage.local.get(PDF_TRANSLATORS_STORAGE_KEY))[PDF_TRANSLATORS_STORAGE_KEY]);
  renderPdfTranslators();
  // 触发规则预设气泡（#101）：直读 chrome.storage.local；内置 paper 常驻不可删（#95），缺失即补
  triggerPresets = mergeBuiltInTriggerPresets((await chrome.storage.local.get(TRIGGER_PRESETS_KEY))[TRIGGER_PRESETS_KEY]);
  renderTriggerPresets();
  // 开关为开时展开日志区并自动加载一次（缺省 false 不加载）
  setDeveloperMode(settings.developerMode === true);
}

init();
