import { createTargetPicker } from './target-picker.js';

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

const ERROR_TEXT = {
  offline: '本地 Bridge 未运行，请启动服务后重试。',
  unpaired: '扩展尚未与本地 Bridge 配对，请先在上方完成配对。',
  auth: '飞书用户未登录或授权已失效，请在终端完成 lark-cli 用户登录。',
  forbidden: '当前飞书用户没有访问该知识库的权限。',
  failed: '查询失败，请稍后重试。',
};

function describeDestination(destination) {
  if (!destination) return '尚未设置';
  const path = Array.isArray(destination.path) && destination.path.length ? destination.path.join(' / ') : null;
  return path && !path.includes(destination.title) ? `${path}（${destination.title}）` : destination.title || destination.nodeToken;
}

function render(picker, state) {
  $('#current-destination').textContent = describeDestination(state.destination);

  const status = $('#picker-status');
  const list = $('#picker-list');
  const crumbs = $('#crumbs');
  list.replaceChildren();
  crumbs.replaceChildren();

  if (state.error) {
    status.textContent = ERROR_TEXT[state.error.kind] || ERROR_TEXT.failed;
    status.className = 'picker-status error-text';
  } else if (state.status === 'loading') {
    status.textContent = '正在加载…';
    status.className = 'picker-status';
  } else {
    status.textContent = '';
    status.className = 'picker-status';
  }

  $('#picker-retry').classList.toggle('hidden', !state.error);
  $('#picker-back').classList.toggle('hidden', state.view !== 'nodes' || state.status === 'loading');
  $('#picker-more').classList.toggle('hidden', state.status !== 'ready' || !(state.view === 'spaces' ? state.spacesHasMore : state.nodesHasMore));

  const items = state.view === 'spaces' ? state.spaces : state.nodes;
  if (state.status === 'ready' && !state.error && items.length === 0) {
    status.textContent = state.view === 'spaces' ? '当前飞书用户没有可访问的知识库。' : '该目录下没有文档。';
  }

  if (state.view === 'nodes') {
    crumbs.classList.remove('hidden');
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'link';
    root.textContent = '知识库';
    root.addEventListener('click', () => picker.goToCrumb(-1));
    crumbs.append(root);
    state.crumbs.forEach((crumb, index) => {
      crumbs.append(document.createTextNode(' / '));
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'link';
      entry.textContent = crumb.title;
      entry.disabled = index === state.crumbs.length - 1;
      entry.addEventListener('click', () => picker.goToCrumb(index));
      crumbs.append(entry);
    });
  } else {
    crumbs.classList.add('hidden');
  }

  if (state.view === 'spaces') {
    for (const space of state.spaces) {
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = `picker-row selectable${space.spaceId === state.selectedSpaceId ? ' selected' : ''}`;
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'row-title';
      title.textContent = space.name;
      title.addEventListener('click', () => picker.selectSpace(space));
      row.append(title);
      const hint = document.createElement('span');
      hint.className = 'row-hint';
      hint.textContent = space.spaceType === 'team' ? '团队' : '个人';
      row.append(hint);
      const drill = document.createElement('button');
      drill.type = 'button';
      drill.className = 'link row-drill';
      drill.textContent = '进入 ›';
      drill.addEventListener('click', () => picker.openSpace(space));
      row.append(drill);
      item.append(row);
      list.append(item);
    }
  } else {
    for (const node of state.nodes) {
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = `picker-row selectable${node.nodeToken === state.selectedNodeToken ? ' selected' : ''}`;
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'row-title';
      title.textContent = node.title || node.nodeToken;
      title.addEventListener('click', () => picker.select(node));
      row.append(title);
      const type = document.createElement('span');
      type.className = 'row-hint';
      type.textContent = node.objType || '';
      row.append(type);
      if (node.hasChildren) {
        const drill = document.createElement('button');
        drill.type = 'button';
        drill.className = 'link row-drill';
        drill.textContent = '进入 ›';
        drill.addEventListener('click', () => picker.openNode(node));
        row.append(drill);
      }
      item.append(row);
      list.append(item);
    }
  }

  const saveButton = $('#picker-save');
  const hasSelection = state.view === 'spaces' ? Boolean(state.selectedSpaceId) : Boolean(state.selectedNodeToken);
  saveButton.classList.remove('hidden');
  saveButton.disabled = state.saving || !hasSelection;
  saveButton.textContent = state.saving ? '正在验证并保存…' : state.view === 'spaces' ? '将该知识库根层设为默认目标' : '设为默认保存目标';
}

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
  picker.subscribe((state) => render(picker, state));

  $('#picker-back').addEventListener('click', () => picker.back());
  $('#picker-retry').addEventListener('click', () => picker.retry());
  $('#picker-more').addEventListener('click', () => {
    const state = picker.getState();
    return state.view === 'spaces' ? picker.loadMoreSpaces() : picker.loadMoreNodes();
  });
  $('#picker-save').addEventListener('click', async () => {
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
