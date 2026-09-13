import { describeDestination, renderPicker, wirePicker, renderDrivePicker, wireDrivePicker } from './picker-view.js';
import { createPopupPicker } from './popup-picker.js';
import { createDrivePicker } from './drive-picker.js';
import { describeAttemptView, initPopupPresets, initPdfTabState, currentPreset, selectPreset, editTitle, editCustomBody, resetTitle, isTitleEdited, primaryLabel, overrideDestination, finalTitle, toggleSection, previewBody, previewScrollTarget, isSessionModified, setIncludeImages, saveAsNewPreset, updateCurrentPreset, composeClip, clipFilename, setMenuOpen, setPdfDetected, setPdfOn, setPdfFolder, presetPdfEnabled, isPdfSessionOnly, isPdfFolderSessionOnly, pdfFolderLabel, formatPdfSize, pdfDisplayName, clipDigest } from './popup-state.js';

let attemptId = null;
let recoveredAttempt = false;
let currentTabUrl = null;
let pollTimer = null;
let popupPicker = null;
let drivePicker = null;
let presetState = null;
let defaultPresetId = null; // SAVE_PRESETS 整体写回时须带上（#40 不改变默认预设）
// 预览懒提取（#37）：首次展开预览才跑 extractor，缓存快照供实时重渲
let previewSnapshot = null;
let previewLoading = false;

const $ = (selector) => document.querySelector(selector);
function message(payload) { return chrome.runtime.sendMessage(payload).then((response) => { if (!response?.ok) throw Object.assign(new Error(response?.error?.message || '操作失败'), response?.error); return response.result; }); }
function show(text, kind = 'info') { const node = $('#status'); $('#status-text').textContent = text; node.className = `status ${kind}`; }
$('#status-close').addEventListener('click', () => { $('#status').className = 'status hidden'; });
// 目标 chip 只反映 presetState：预设目标不亮徽标，「仅本次」徽标只属于手动覆盖的临时目标
function syncDestinationView() {
  const value = presetState.destination;
  $('#destination').textContent = value ? describeDestination(value) : '尚未设置';
  // 图标随目标类型切换（知识库 / 文档节点），与原型一致
  $('.chip-icon').textContent = value?.kind === 'node' ? '📁' : '🗂';
  $('#destination-temp-badge').classList.toggle('hidden', !presetState.temporary);
}

// 预设 chips 与标题输入框的 DOM 同步；归约逻辑全在 popup-state.js
function renderPresetChips() {
  const row = $('#presets');
  row.innerHTML = '';
  for (const preset of presetState.presets) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `preset-chip${preset.id === presetState.presetId ? ' on' : ''}`;
    chip.textContent = preset.name;
    chip.addEventListener('click', () => {
      presetState = selectPreset(presetState, preset.id);
      syncPresetView();
    });
    row.appendChild(chip);
  }
  // 命中提示在 chips 行下方独立一行（#40 移出滚动容器）；只在 viaTrigger 时显示，
  // 手动切换预设（selectPreset 清除 viaTrigger）后消失
  $('#trigger-hint').classList.toggle('hidden', !presetState.viaTrigger);
}

function syncPresetView() {
  $('#page-title').value = presetState.title;
  $('#title-reset').classList.toggle('hidden', !isTitleEdited(presetState));
  $('#save').textContent = primaryLabel(currentPreset(presetState).action, presetState);
  $('#images').checked = presetState.imageMode !== 'off';
  $('#custom-body').value = presetState.customBody;
  $('#preview-title').textContent = presetState.title;
  // ▾ 菜单的「默认 ✓」标记跟随当前预设 action（仅标识，不影响一次性执行）
  document.querySelectorAll('.action-menu-row').forEach((row) => {
    row.querySelector('.action-check').classList.toggle('hidden', row.dataset.action !== currentPreset(presetState).action);
  });
  syncDestinationView();
  renderPresetChips();
  syncPdfView();
  syncModifiedButtons();
  refreshPreview();
}

// ——— PDF 存云盘（#65，#59 变体 A）：识别到主 PDF 才出现相关 UI ———
// 折叠区内开关行（副标题 = 文件名 · 大小，与预设默认不一致时标「仅本次」）；
// 预设未开且本次未启用时，折叠区外显示虚线发现性入口，点击即本次启用（不回写预设）
function syncPdfView() {
  const detected = presetState.pdf;
  $('#pdf-row').classList.toggle('hidden', !detected);
  if (detected) {
    $('#pdf').checked = presetState.pdfOn;
    $('#pdf-sub').textContent = `${pdfDisplayName(detected)} · ${formatPdfSize(detected.sizeBytes)}`;
    $('#pdf-temp-badge').classList.toggle('hidden', !isPdfSessionOnly(presetState));
  }
  // 目录 chip（#66）：开关开启后才出现；显示会话目录（初值 = 预设目录），
  // 目录偏离预设时单独亮「仅本次」徽标
  const showFolder = Boolean(detected) && presetState.pdfOn;
  $('#pdf-folder').classList.toggle('hidden', !showFolder);
  if (showFolder) {
    $('#pdf-folder-name').textContent = pdfFolderLabel(presetState);
    $('#pdf-folder-temp-badge').classList.toggle('hidden', !isPdfFolderSessionOnly(presetState));
  } else {
    closeDrivePicker();
  }
  const discoverable = detected && !presetState.pdfOn && !presetPdfEnabled(presetState);
  $('#pdf-discover').classList.toggle('hidden', !discoverable);
  if (discoverable) {
    $('#pdf-discover').textContent = `📕 本页包含 PDF（${formatPdfSize(detected.sizeBytes)}）—— 本次顺带存入云盘 ›`;
  }
  $('#save').textContent = primaryLabel(currentPreset(presetState).action, presetState);
}

// ——— dirty 按钮显隐（#40 保存为新预设 / #41 修改预设）：两个按钮共用 isSessionModified
// 同一 dirty 判定，可同时出现、互不影响；visibility 隐藏保留占位，布局不跳动；
// 命名条只能由点击「保存为新预设」触发，按钮回到隐藏态时命名条一并收起 ———
function syncModifiedButtons() {
  const modified = isSessionModified(presetState);
  $('#save-as-preset').style.visibility = modified ? 'visible' : 'hidden';
  $('#update-preset').style.visibility = modified ? 'visible' : 'hidden';
  if (!modified) hideSaveAsBar();
}

function hideSaveAsBar() {
  $('#save-as-bar').classList.add('hidden');
}

// ——— 本次设置 / 预览折叠区（#37）：两个折叠区状态独立 ———
function syncFolds() {
  $('#settings-body').classList.toggle('hidden', !presetState.settingsOpen);
  $('#settings-caret').textContent = presetState.settingsOpen ? '⌃' : '⌄';
  $('#settings-toggle').setAttribute('aria-expanded', String(presetState.settingsOpen));
  $('#preview-body').classList.toggle('hidden', !presetState.previewOpen);
  $('#preview-caret').textContent = presetState.previewOpen ? '收起 ⌃' : '展开 ⌄';
  $('#preview-toggle').setAttribute('aria-expanded', String(presetState.previewOpen));
}

// 预览文本 = 最终保存正文（同一 renderBody 路径）；快照未就绪时不动。
// 重渲后按 previewScrollTarget 滚动到自定义文本所在端（见 popup-state.js 注释）
function refreshPreview(trigger = 'refresh') {
  if (!presetState.previewOpen || !previewSnapshot) return;
  const body = $('#preview-body');
  body.textContent = previewBody(presetState, previewSnapshot);
  const target = previewScrollTarget(trigger, presetState);
  if (target === 'end') body.scrollTop = body.scrollHeight;
  else if (target === 'top') body.scrollTop = 0;
}

// 快照缓存（#37 预览懒提取，#38 导出动作复用）：预览提取过的快照导出直接用，不重复提取
async function ensureSnapshot() {
  if (previewSnapshot) return previewSnapshot;
  previewSnapshot = await message({ type: 'EXTRACT' });
  return previewSnapshot;
}

async function ensurePreviewSnapshot() {
  if (previewSnapshot || previewLoading) return;
  previewLoading = true;
  $('#preview-body').textContent = '正在提取页面…';
  try {
    previewSnapshot = await message({ type: 'EXTRACT' });
    refreshPreview('open');
  } catch (error) {
    $('#preview-body').textContent = `预览提取失败：${error.message}`;
  } finally {
    previewLoading = false;
  }
}

const POPUP_LABELS = {
  saveSpace: '仅本次保存到该知识库根层',
  saveNode: '仅本次使用该目标',
  saving: '正在验证…',
};

function pickerElements() {
  return {
    status: $('#tp-status'),
    list: $('#tp-list'),
    crumbs: $('#tp-crumbs'),
    more: $('#tp-more'),
    back: $('#tp-back'),
    retry: $('#tp-retry'),
    save: $('#tp-confirm'),
  };
}

async function openPicker() {
  $('#picker-panel').classList.remove('hidden');
  // 每次打开都新建控制器：状态全新，不会意外复用上一次的临时选择
  popupPicker = createPopupPicker({
    listSpaces: ({ cursor, limit }) => message({ type: 'LIST_SPACES', cursor, limit }),
    listNodes: ({ spaceId, parentNodeToken, cursor, limit }) => message({ type: 'LIST_NODES', spaceId, parentNodeToken, cursor, limit }),
    validateDestination: (candidate) => message({ type: 'VALIDATE_DESTINATION', destination: candidate }),
  });
  const els = pickerElements();
  popupPicker.subscribe((state) => renderPicker(popupPicker, state, els, POPUP_LABELS));
  wirePicker(popupPicker, els);
  await popupPicker.start();
}

function closePicker() {
  $('#picker-panel').classList.add('hidden');
  popupPicker = null;
}

// ——— PDF 云盘目录 picker（#66）：同一 overlay 形态，数据源是 drive 端点族；仅本次生效 ———
const DRIVE_POPUP_LABELS = {
  saveRoot: '仅本次存到云盘根目录',
  saveFolder: '仅本次存到该目录',
  saving: '正在验证…',
};

function drivePickerElements() {
  return {
    status: $('#dp-status'),
    list: $('#dp-list'),
    crumbs: $('#dp-crumbs'),
    more: $('#dp-more'),
    back: $('#dp-back'),
    retry: $('#dp-retry'),
    save: $('#dp-confirm'),
  };
}

async function openDrivePicker() {
  $('#drive-picker-panel').classList.remove('hidden');
  // 每次打开都新建控制器：状态全新，不会意外复用上一次的临时选择
  drivePicker = createDrivePicker({
    listFolders: ({ folderToken, cursor, limit }) => message({ type: 'LIST_DRIVE_FOLDERS', folderToken, cursor, limit }),
    validateFolder: async ({ folderToken }) => (await message({ type: 'VALIDATE_DRIVE_FOLDER', folderToken })).folder,
    initialDestination: presetState.pdfFolder
      ? { folderToken: presetState.pdfFolder.folderToken, title: presetState.pdfFolder.folderName ?? '我的空间' }
      : null,
  });
  const els = drivePickerElements();
  drivePicker.subscribe((state) => renderDrivePicker(drivePicker, state, els, DRIVE_POPUP_LABELS));
  wireDrivePicker(drivePicker, els);
  await drivePicker.start();
}

function closeDrivePicker() {
  $('#drive-picker-panel').classList.add('hidden');
  drivePicker = null;
}

$('#pdf-folder').addEventListener('click', () => {
  if ($('#drive-picker-panel').classList.contains('hidden')) openDrivePicker();
  else closeDrivePicker();
});
$('#dp-cancel').addEventListener('click', closeDrivePicker);
$('#drive-picker-mask').addEventListener('click', closeDrivePicker);
$('#dp-confirm').addEventListener('click', async () => {
  if (!drivePicker) return;
  const saved = await drivePicker.saveSelection();
  if (saved) {
    presetState = setPdfFolder(presetState, { folderToken: saved.folderToken ?? null, folderName: saved.title });
    // pdf-tab 形态（#67）：目录 chip 只影响单面板展示与本次提交，不参与预设 dirty 判定
    if (presetState.pageKind === 'pdf-tab') syncPdfTabView();
    else { syncPdfView(); syncModifiedButtons(); }
    closeDrivePicker();
    show(`本次 PDF 将存到：${(saved.path ?? []).concat(saved.title).join(' / ')}。预设目录不变。`);
  } else {
    // token 失效/不可写：报错并保持面板打开，可直接重选，无静默回退
    show(`目录验证失败：${drivePicker.getState().error?.message || '请重新选择'}`, 'error');
  }
});

// ——— PDF 标签页单面板（#67）：页面本身是 PDF 时正文区整体换形态，不产生剪藏 job ———
// 主按钮三态：保存（可点）→ 上传中（禁用）→ 打开云盘 PDF ↗（pdfTabDone 置位后跳转）
let pdfTabDone = false;

function enterPdfTabMode() {
  document.querySelector('.title-wrap').classList.add('hidden');
  $('#web-panel').classList.add('hidden');
  $('#pdf-tab-panel').classList.remove('hidden');
  syncPdfTabView();
}

function syncPdfTabView() {
  const pdf = presetState.pdf;
  $('#pdf-tab-name').textContent = pdfDisplayName(pdf);
  $('#pdf-tab-meta').textContent = formatPdfSize(pdf?.sizeBytes);
  $('#pdf-tab-folder-name').textContent = pdfFolderLabel(presetState);
}

// 单面板的 job 视图落地：复用 describeAttemptView 的 pdf-only 分支（进度/成功/失败）
function applyPdfTabView(view) {
  const button = $('#pdf-tab-save');
  if (view.kind === 'success' || view.kind === 'warning') {
    show(view.message, view.kind);
    if (view.pdfUrl) {
      pdfTabDone = true;
      button.disabled = false;
      button.textContent = '打开云盘 PDF ↗';
      button.dataset.url = view.pdfUrl;
    }
    recoveredAttempt = false;
  } else if (view.kind === 'failure') {
    show(view.message, 'error');
    // 失败后主按钮回到保存态：再点一次 = 复用同一 attemptId 重试（bridge 复位重排 pdf job）
    button.disabled = false;
    button.textContent = '⬇ 保存 PDF 到云盘';
    recoveredAttempt = false;
  } else {
    show(view.message);
    button.disabled = true;
    button.textContent = '上传中…';
    pollTimer = setTimeout(poll, 900);
  }
}

async function savePdfTab() {
  if (pdfTabDone) {
    chrome.tabs.create({ url: $('#pdf-tab-save').dataset.url });
    return;
  }
  const button = $('#pdf-tab-save');
  button.disabled = true;
  show('正在提交 PDF 上传…');
  try {
    const result = await message({
      type: 'SAVE_PDF_TAB',
      // 恢复指针可能属于别的页面（跨页恢复），不能当 attemptId 复用——同键异 URL 会被
      // job-store 拒绝。只有本会话发起过、或 poll 已确认同页归属后才复用（失败重试重排）
      attemptId: recoveredAttempt ? null : attemptId,
      pdfSource: presetState.pdf,
      pdfFolderToken: presetState.pdfFolder?.folderToken ?? null,
    });
    attemptId = result.pdfJob?.attemptId ?? attemptId;
    recoveredAttempt = false;
    poll();
  } catch (error) {
    show(error.message, 'error');
    button.disabled = false;
  }
}
$('#pdf-tab-save').addEventListener('click', savePdfTab);
$('#pdf-tab-folder').addEventListener('click', () => {
  if ($('#drive-picker-panel').classList.contains('hidden')) openDrivePicker();
  else closeDrivePicker();
});

async function inspect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab?.url || null;
  try { $('#page-host').textContent = new URL(tab.url).host; } catch { $('#page-host').textContent = ''; }
  const settings = await message({ type: 'GET_SETTINGS' });
  defaultPresetId = settings.defaultPresetId ?? null;
  attemptId = settings.activeAttempt || null;
  recoveredAttempt = Boolean(attemptId);
  // PDF 标签页判定（#67）先于网页剪藏初始化：命中即整体切换单面板形态，
  // 不跑 trigger/标题渲染，也不再发 #65 的主 PDF 探测（该探测面向网页内 PDF）
  const { pdfTab } = await message({ type: 'DETECT_PDF_TAB' }).catch(() => ({ pdfTab: null }));
  if (pdfTab) {
    presetState = initPdfTabState(settings, pdfTab);
    enterPdfTabMode();
  } else {
    presetState = initPopupPresets(settings, tab);
    syncPresetView();
  }
  try {
    let status = await message({ type: 'STATUS' });
    // 重载扩展后首次查询可能赶上 lark-cli 冷启动/网络抖动，未就绪时延迟重试一次再下结论
    if (!status.larkAuth?.ready) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      status = await message({ type: 'STATUS' });
    }
    $('#bridge').textContent = status.larkAuth?.ready ? `Bridge ${status.version} · 飞书已登录` : `Bridge ${status.version} · 飞书未登录`;
    if (!status.larkAuth?.ready) show('请先在终端完成 lark-cli 用户登录。', 'error');
  } catch (error) {
    $('#bridge').textContent = error.code === 'BRIDGE_OFFLINE' ? 'Bridge 未运行' : '需要配对';
    show(error.code === 'BRIDGE_OFFLINE' ? '本地 Bridge 未运行，请启动服务后重试。' : '请打开设置完成扩展配对。', 'error');
  }
  if (attemptId) poll();
  // 主 PDF 轻量探测（#65）：异步补齐识别结果，不阻塞弹窗首屏；探测失败按未识别处理。
  // pdf-tab 形态（#67）不跑：页面本身就是 PDF，没有"网页内主 PDF"可探测
  if (presetState.pageKind === 'pdf-tab') return;
  message({ type: 'DETECT_PDF' }).then(({ pdf }) => {
    if (!pdf) return;
    presetState = setPdfDetected(presetState, pdf);
    syncPdfView();
  }).catch(() => {});
}

// 凭据回传（#68）：pdf job 进 awaiting_bytes 即经 SW 持凭据抓取并分块回传。
// 每个弹窗会话只触发一次（SW 侧另有 in-flight 去重）；失败后 job 留在 awaiting_bytes，
// 重开弹窗可重试——bridge 位图保证不重传已确认块
let pdfFeedStarted = false;
function triggerPdfFeed(jobs) {
  if (pdfFeedStarted) return;
  const pdfJob = jobs.find((job) => job.kind === 'pdf');
  const pdfUrl = pdfJob?.pdfSource?.url ?? presetState?.pdf?.url;
  if (!pdfJob || !pdfUrl) return;
  pdfFeedStarted = true;
  message({ type: 'FEED_PDF_BYTES', attemptId, pdfUrl, name: pdfJob.pdfSource?.name ?? presetState?.pdf?.name ?? null })
    .catch((error) => show(`PDF 凭据回传失败：${error.message}。重开弹窗可重试。`, 'error'));
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const { jobs } = await message({ type: 'GET_JOB', attemptId, pageUrl: currentTabUrl });
    // 空数组 = 该 attempt 属于别的页面（跨页恢复）：静默丢弃，不展示任何状态
    if (!jobs || jobs.length === 0) { attemptId = null; recoveredAttempt = false; return; }
    const view = describeAttemptView(jobs, { recovered: recoveredAttempt });
    if (!view) return;
    // 凭据回传触发（#68）：两种页面形态共用 poll，awaiting_bytes 即开始/继续喂字节
    if (view.pdfAwaitingBytes) triggerPdfFeed(jobs);
    // PDF 标签页形态（#67）：view 落到单面板主按钮/状态条，不触碰网页形态的 CTA 区
    if (presetState.pageKind === 'pdf-tab') {
      applyPdfTabView(view);
      return;
    }
    if (view.kind === 'success' || view.kind === 'warning') {
      show(view.message, view.kind);
      if (view.documentUrl) { $('#open').classList.remove('hidden'); $('#open').dataset.url = view.documentUrl; }
      if (view.pdfUrl) { $('#open-pdf').classList.remove('hidden'); $('#open-pdf').dataset.url = view.pdfUrl; }
      // PDF 失败时给出只重跑 pdf job 的重试入口（#60：双 job 各自独立成败）
      if (view.pdfRetry) $('#retry-pdf').classList.remove('hidden');
      // 仅本次会话发起的保存成功才切换主按钮；恢复的旧成功态保留「保存到飞书」以便直接发起新剪藏
      if (view.swapPrimary) setSaveVisible(false);
      recoveredAttempt = false;
    } else if (view.kind === 'failure') {
      show(view.message, 'error'); $('#save').disabled = false;
      // 文档失败但 PDF 已存云盘：PDF 产物链接仍可打开（变体 A）
      if (view.pdfUrl) { $('#open-pdf').classList.remove('hidden'); $('#open-pdf').dataset.url = view.pdfUrl; }
      if (view.pdfRetry) $('#retry-pdf').classList.remove('hidden');
      recoveredAttempt = false;
    } else {
      show(view.message);
      pollTimer = setTimeout(poll, 900);
    }
  } catch (error) { show(error.message, 'error'); }
}

$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
// 两个折叠区各自独立开关
$('#settings-toggle').addEventListener('click', () => {
  presetState = toggleSection(presetState, 'settings');
  syncFolds();
});
$('#preview-toggle').addEventListener('click', async () => {
  presetState = toggleSection(presetState, 'preview');
  syncFolds();
  if (presetState.previewOpen) await ensurePreviewSnapshot();
});
// 自定义正文（仅本次）：预填所选预设的 bodyTemplate，编辑只影响本次，不回写预设；
// 预览开着时实时重渲并滚到自定义文本所在端
$('#custom-body').addEventListener('input', (event) => {
  presetState = editCustomBody(presetState, event.target.value);
  refreshPreview('body');
  syncModifiedButtons();
});
$('#change').addEventListener('click', () => {
  if ($('#picker-panel').classList.contains('hidden')) openPicker();
  else closePicker();
});
$('#tp-cancel').addEventListener('click', closePicker);
$('#picker-mask').addEventListener('click', closePicker);
$('#tp-confirm').addEventListener('click', async () => {
  if (!popupPicker) return;
  const saved = await popupPicker.saveSelection();
  if (saved) {
    presetState = overrideDestination(presetState, saved);
    syncDestinationView();
    syncModifiedButtons();
    closePicker();
    show(`本次将保存到：${describeDestination(saved)}。默认目标不变。`);
  } else {
    show(`目标验证失败：${popupPicker.getState().error?.message || '请重新选择'}`, 'error');
  }
});
// 包含图片 switch 的仅本次改动进 state，参与「存为新预设」的 diff 判定
$('#images').addEventListener('change', (event) => {
  presetState = setIncludeImages(presetState, event.target.checked);
  syncModifiedButtons();
});
// PDF 存云盘（#65）：折叠区内开关与折叠区外发现性入口都是仅本次改动，不回写预设；
// 想固化由用户显式点「修改预设」（与其他会话字段同一语义）
$('#pdf').addEventListener('change', (event) => {
  presetState = setPdfOn(presetState, event.target.checked);
  syncPdfView();
  syncModifiedButtons();
});
$('#pdf-discover').addEventListener('click', () => {
  presetState = setPdfOn(presetState, true);
  syncPdfView();
  syncModifiedButtons();
  show('已开启本次「PDF 存云盘」，不影响预设默认值。');
});
// ——— 保存为新预设（#40）：内联命名条，空名不允许（确认键禁用），重名允许（以 id 区分）———
function syncSaveAsConfirm() {
  $('#save-as-confirm').disabled = $('#save-as-name').value.trim() === '';
}
$('#save-as-preset').addEventListener('click', () => {
  if (!isSessionModified(presetState)) return;
  $('#save-as-bar').classList.remove('hidden');
  const input = $('#save-as-name');
  input.value = `${currentPreset(presetState).name} 副本`;
  syncSaveAsConfirm();
  input.focus();
});
$('#save-as-name').addEventListener('input', syncSaveAsConfirm);
$('#save-as-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !$('#save-as-confirm').disabled) $('#save-as-confirm').click();
  if (event.key === 'Escape') hideSaveAsBar();
});
$('#save-as-cancel').addEventListener('click', hideSaveAsBar);
$('#save-as-confirm').addEventListener('click', async () => {
  const result = saveAsNewPreset(presetState, $('#save-as-name').value);
  if (!result) return;
  $('#save-as-confirm').disabled = true;
  try {
    await message({ type: 'SAVE_PRESETS', presets: result.state.presets, defaultPresetId });
    presetState = result.state;
    hideSaveAsBar();
    syncPresetView();
    show(`已保存为新预设「${result.preset.name}」。`, 'success');
  } catch (error) {
    show(`保存预设失败：${error.message}`, 'error');
    syncSaveAsConfirm();
  }
});
// ——— 修改预设（#41）：把本次改动写回当前选中预设，不新建、无需命名条；
// 持久化成功后 session 不再 dirty，按钮随 syncModifiedButtons 消失 ———
async function writeBackPreset() {
  if (!isSessionModified(presetState)) return;
  const button = $('#update-preset');
  if (button.dataset.busy) return; // 防连点并发写回（save-as 路径有 disabled 守卫，这里对齐）
  const result = updateCurrentPreset(presetState);
  if (!result) return;
  button.dataset.busy = '1';
  try {
    await message({ type: 'SAVE_PRESETS', presets: result.state.presets, defaultPresetId });
    presetState = result.state;
    syncPresetView();
    show(`已写回预设「${result.preset.name}」。`, 'success');
  } catch (error) {
    show(`写回预设失败：${error.message}`, 'error');
  } finally {
    delete button.dataset.busy;
  }
}
// 按钮嵌在折叠头里（span 模拟，button 不能套 button）：写回不触发折叠开关
$('#update-preset').addEventListener('click', (event) => {
  event.stopPropagation();
  writeBackPreset();
});
$('#update-preset').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  writeBackPreset();
});
// 保存到飞书：走 background CLIP（内部提取 + 建 job），job 恢复逻辑不变
async function clipToFeishu() {
  if (!presetState.destination) { show('请先在设置中配置默认保存目标。', 'error'); return; }
  $('#save').disabled = true; show('正在提取当前页面…');
  try {
    // 语义 B：标题框内容保存时再过一遍模板渲染，清洗与空白回退在 background 完成；
    // 正文合成也在 background 用同一 renderBody 完成，有效模板 = 自定义正文框内容
    const result = await message({
      type: 'CLIP',
      destination: presetState.destination,
      includeImages: $('#images').checked,
      imageMode: presetState.imageMode,
      title: finalTitle(presetState),
      customBody: presetState.customBody,
      // PDF 存云盘（#65）：本次开了开关且识别到主 PDF 时附带 pdfSource，bridge 建双 job；
      // pdfFolderToken（#66）是目录 chip 的会话选择（null = 云盘根目录）
      pdfEnabled: presetState.pdfOn && Boolean(presetState.pdf),
      pdfSource: presetState.pdf,
      pdfFolderToken: presetState.pdfFolder?.folderToken ?? null,
      // AI 摘要（#75）：预设开关 + 预设级指令；全局回落在 background 解析
      ...clipDigest(presetState),
    });
    attemptId = result.job.attemptId;
    recoveredAttempt = false;
    $('#open').classList.add('hidden'); $('#open-pdf').classList.add('hidden'); $('#retry-pdf').classList.add('hidden');
    setSaveVisible(true);
    poll();
  }
  catch (error) { show(error.code === 'INVALID_TARGET' ? '保存目标已失效，请重新选择。' : error.message, 'error'); $('#save').disabled = false; }
}

// 重试 PDF（#65）：复用同一 attemptId 重新提交——bridge 侧 clip job 幂等命中不动，
// 仅 failed 的 pdf job 复位重跑；与主按钮的新剪藏（新 attempt）互不干扰
async function retryPdf() {
  $('#retry-pdf').classList.add('hidden');
  show('正在重试 PDF 上传…');
  try {
    await message({
      type: 'CLIP',
      attemptId,
      destination: presetState.destination,
      includeImages: $('#images').checked,
      imageMode: presetState.imageMode,
      title: finalTitle(presetState),
      customBody: presetState.customBody,
      pdfEnabled: true,
      pdfSource: presetState.pdf,
      pdfFolderToken: presetState.pdfFolder?.folderToken ?? null,
      // AI 摘要（#75）：与主保存同一口径，重试重排沿用预设开关
      ...clipDigest(presetState),
    });
    poll();
  } catch (error) {
    show(error.message, 'error');
    $('#retry-pdf').classList.remove('hidden');
  }
}
$('#retry-pdf').addEventListener('click', retryPdf);

// 导出动作（#38）：复制到剪贴板 / 保存为文件。完全在扩展侧完成——不过 Bridge、
// 不创建 job、不影响 job 恢复；内容与保存/预览共用 composeClip 路径
async function exportClip(action) {
  $('#save').disabled = true; show('正在提取当前页面…');
  try {
    const snapshot = await ensureSnapshot();
    const { title, body } = composeClip(presetState, snapshot);
    if (action === 'clipboard') {
      await navigator.clipboard.writeText(body);
      show('已复制到剪贴板。', 'success');
    } else {
      // popup 是扩展页面，Blob/URL.createObjectURL 可用（service worker 里不可用）
      const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown' }));
      try {
        await chrome.downloads.download({ url, filename: clipFilename(title), saveAs: true });
        show('已保存为文件。', 'success');
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch (error) {
    show(error.code === 'UNSUPPORTED_PAGE' ? '当前页面不支持剪藏' : error.message, 'error');
  } finally {
    $('#save').disabled = false;
  }
}

// 一次性执行菜单：选中即执行并收起，不改变主动作文字、不回写预设 action
function runAction(action) {
  presetState = setMenuOpen(presetState, false);
  syncMenu();
  if (action === 'feishu') clipToFeishu();
  else exportClip(action);
}

function syncMenu() {
  $('#action-menu').classList.toggle('hidden', !presetState.menuOpen);
  $('#action-menu-toggle').setAttribute('aria-expanded', String(presetState.menuOpen));
}

// 保存成功切换主按钮时，split 的左右两半一起隐藏/恢复
function setSaveVisible(visible) {
  $('#save').classList.toggle('hidden', !visible);
  $('#action-menu-toggle').classList.toggle('hidden', !visible);
}

$('#save').addEventListener('click', () => runAction(currentPreset(presetState).action));
$('#action-menu-toggle').addEventListener('click', (event) => {
  event.stopPropagation();
  presetState = setMenuOpen(presetState, !presetState.menuOpen);
  syncMenu();
});
document.querySelectorAll('.action-menu-row').forEach((row) => {
  row.addEventListener('click', (event) => {
    event.stopPropagation();
    runAction(row.dataset.action);
  });
});
// 点外部 / Esc 收起菜单
document.addEventListener('click', (event) => {
  if (presetState?.menuOpen && !event.target.closest('.split')) {
    presetState = setMenuOpen(presetState, false);
    syncMenu();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && presetState?.menuOpen) {
    presetState = setMenuOpen(presetState, false);
    syncMenu();
  }
});
$('#open').addEventListener('click', () => chrome.tabs.create({ url: $('#open').dataset.url }));
$('#open-pdf').addEventListener('click', () => chrome.tabs.create({ url: $('#open-pdf').dataset.url }));
// 手动编辑标题：不立即重写输入框（避免光标跳动），只更新状态与 ↺ 可见性
$('#page-title').addEventListener('input', (event) => {
  presetState = editTitle(presetState, event.target.value);
  $('#title-reset').classList.toggle('hidden', !isTitleEdited(presetState));
  $('#preview-title').textContent = presetState.title;
  refreshPreview();
  syncModifiedButtons();
});
$('#title-reset').addEventListener('click', () => {
  presetState = resetTitle(presetState);
  $('#page-title').value = presetState.title;
  $('#title-reset').classList.add('hidden');
  $('#preview-title').textContent = presetState.title;
  refreshPreview();
  syncModifiedButtons();
});
inspect();
