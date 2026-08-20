import { describeDestination, renderPicker, wirePicker } from './picker-view.js';
import { createPopupPicker } from './popup-picker.js';

const terminal = new Set(['succeeded', 'succeeded_with_warnings', 'failed', 'needs_attention', 'expired', 'cancelled', 'cancelled_with_document']);
let destination = null;
let attemptId = null;
let pollTimer = null;
let popupPicker = null;

const $ = (selector) => document.querySelector(selector);
function message(payload) { return chrome.runtime.sendMessage(payload).then((response) => { if (!response?.ok) throw Object.assign(new Error(response?.error?.message || '操作失败'), response?.error); return response.result; }); }
function show(text, kind = 'info') { const node = $('#status'); node.textContent = text; node.className = `status ${kind}`; }
function setDestination(value, temporary = false) {
  destination = value;
  $('#destination').textContent = value ? describeDestination(value) : '尚未设置';
  $('#destination-kind').textContent = temporary ? '仅本次剪藏' : '默认保存目标';
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

async function inspect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#page-title').textContent = tab?.title || '当前页面';
  try { $('#page-host').textContent = new URL(tab.url).host; } catch { $('#page-host').textContent = ''; }
  const settings = await message({ type: 'GET_SETTINGS' });
  setDestination(settings.destination);
  attemptId = settings.activeAttempt || null;
  try {
    const status = await message({ type: 'STATUS' });
    $('#bridge').textContent = status.larkAuth?.ready ? `Bridge ${status.version} · 飞书已登录` : `Bridge ${status.version} · 飞书未登录`;
    if (!status.larkAuth?.ready) show('请先在终端完成 lark-cli 用户登录。', 'error');
  } catch (error) {
    $('#bridge').textContent = error.code === 'BRIDGE_OFFLINE' ? 'Bridge 未运行' : '需要配对';
    show(error.code === 'BRIDGE_OFFLINE' ? '本地 Bridge 未运行，请启动服务后重试。' : '请打开设置完成扩展配对。', 'error');
  }
  if (attemptId) poll();
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const { job } = await message({ type: 'GET_JOB', attemptId });
    if (job.status === 'succeeded' || job.status === 'succeeded_with_warnings') {
      show(job.status === 'succeeded' ? '已保存到飞书。' : `正文已保存；${job.warnings.length} 张图片需要注意。`, job.status === 'succeeded' ? 'success' : 'warning');
      $('#save').classList.add('hidden'); $('#open').classList.remove('hidden'); $('#open').dataset.url = job.document.url;
    } else if (terminal.has(job.status)) {
      show(job.error || '剪藏未完成，请修复后重新发起。', 'error'); $('#save').disabled = false;
    } else {
      show(job.status === 'queued' ? '已提交，等待本地 Bridge 处理…' : '正在创建飞书文档并处理图片…');
      pollTimer = setTimeout(poll, 900);
    }
  } catch (error) { show(error.message, 'error'); }
}

$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#change').addEventListener('click', () => {
  if ($('#picker-panel').classList.contains('hidden')) openPicker();
  else closePicker();
});
$('#tp-cancel').addEventListener('click', closePicker);
$('#tp-confirm').addEventListener('click', async () => {
  if (!popupPicker) return;
  const saved = await popupPicker.saveSelection();
  if (saved) {
    setDestination(saved, true);
    closePicker();
    show(`本次将保存到：${describeDestination(saved)}。默认目标不变。`);
  } else {
    show(`目标验证失败：${popupPicker.getState().error?.message || '请重新选择'}`, 'error');
  }
});
$('#save').addEventListener('click', async () => {
  if (!destination) { show('请先在设置中配置默认保存目标。', 'error'); return; }
  $('#save').disabled = true; show('正在提取当前页面…');
  try { const result = await message({ type: 'CLIP', destination, includeImages: $('#images').checked }); attemptId = result.job.attemptId; poll(); }
  catch (error) { show(error.code === 'INVALID_TARGET' ? '保存目标已失效，请重新选择。' : error.message, 'error'); $('#save').disabled = false; }
});
$('#open').addEventListener('click', () => chrome.tabs.create({ url: $('#open').dataset.url }));
inspect();
