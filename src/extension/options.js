import { createTargetPicker } from './target-picker.js';
import { describeDestination, renderPicker, wirePicker } from './picker-view.js';

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

const OPTIONS_LABELS = {
  saveSpace: '将该知识库根层设为默认目标',
  saveNode: '设为默认保存目标',
  saving: '正在验证并保存…',
};

async function init() {
  const { destination } = await chrome.storage.local.get(['destination']);
  if (destination) {
    $('#token').value = destination.nodeToken || '';
    $('#space').value = destination.spaceId || '';
  }
  const picker = createTargetPicker({
    listSpaces: ({ cursor, limit }) => message({ type: 'LIST_SPACES', cursor, limit }),
    listNodes: ({ spaceId, parentNodeToken, cursor, limit }) => message({ type: 'LIST_NODES', spaceId, parentNodeToken, cursor, limit }),
    saveDestination: (destinationToSave) => message({ type: 'SAVE_DESTINATION', destination: destinationToSave }),
    initialDestination: destination || null,
  });

  const els = {
    status: $('#picker-status'),
    list: $('#picker-list'),
    crumbs: $('#crumbs'),
    more: $('#picker-more'),
    back: $('#picker-back'),
    retry: $('#picker-retry'),
    save: $('#picker-save'),
  };
  picker.subscribe((state) => {
    $('#current-destination').textContent = describeDestination(state.destination);
    renderPicker(picker, state, els, OPTIONS_LABELS);
  });
  wirePicker(picker, els);

  els.save.addEventListener('click', async () => {
    const saved = await picker.saveSelection();
    if (saved) show(`默认目标已保存：${describeDestination(picker.getState().destination)}`, 'success');
    else show(`保存失败：${picker.getState().error?.message || '请重试'}`, 'error');
  });
  $('#save-target').addEventListener('click', async () => {
    const nodeToken = $('#token').value.trim();
    const spaceId = $('#space').value.trim() || undefined;
    if (!nodeToken && !spaceId) { show('请填写 Wiki 节点 token 或空间 ID。', 'error'); return; }
    const saved = nodeToken
      ? await picker.saveManual({ kind: 'node', nodeToken, spaceId })
      : await picker.saveManual({ kind: 'space', spaceId });
    if (saved) show(`默认目标已保存：${describeDestination(picker.getState().destination)}`, 'success');
    else show(`目标验证失败：${picker.getState().error?.message || '请重试'}`, 'error');
  });

  await picker.start();
}

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

init();
