// target-picker 控制器的共享 DOM 渲染层。options.js（预设目标，#35）与 popup.js（仅本次目标）
// 各自传入自己的元素引用和操作文案；控制器逻辑见 target-picker.js。

export const PICKER_ERROR_TEXT = {
  offline: '本地 Bridge 未运行，请启动服务后重试。',
  unpaired: '扩展尚未与本地 Bridge 配对，请先在设置中完成配对。',
  auth: '飞书用户未登录或授权已失效，请在终端完成 lark-cli 用户登录。',
  forbidden: '当前飞书用户没有访问该知识库的权限。',
  failed: '查询失败，请稍后重试。',
};

export function describeDestination(destination) {
  if (!destination) return '尚未设置';
  const path = Array.isArray(destination.path) && destination.path.length ? destination.path.join(' / ') : null;
  return path && !path.includes(destination.title) ? `${path}（${destination.title}）` : destination.title || destination.nodeToken;
}

// els: { status, list, crumbs, more, back, retry, save }
// labels: { saveSpace, saveNode, saving }
export function renderPicker(picker, state, els, labels) {
  const { status, list, crumbs } = els;
  list.replaceChildren();
  crumbs.replaceChildren();

  if (state.error) {
    status.textContent = PICKER_ERROR_TEXT[state.error.kind] || PICKER_ERROR_TEXT.failed;
    status.className = 'picker-status error-text';
  } else if (state.status === 'loading') {
    status.textContent = '正在加载…';
    status.className = 'picker-status';
  } else {
    status.textContent = '';
    status.className = 'picker-status';
  }

  els.retry.classList.toggle('hidden', !state.error);
  els.back.classList.toggle('hidden', state.view !== 'nodes' || state.status === 'loading');
  els.more.classList.toggle('hidden', state.status !== 'ready' || !(state.view === 'spaces' ? state.spacesHasMore : state.nodesHasMore));

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
      // 整行可点（不只文字），下钻按钮阻止冒泡以免误选中
      row.addEventListener('click', () => picker.selectSpace(space));
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'row-title';
      title.textContent = space.name;
      row.append(title);
      const hint = document.createElement('span');
      hint.className = 'row-hint';
      hint.textContent = space.spaceType === 'team' ? '团队' : '个人';
      row.append(hint);
      const drill = document.createElement('button');
      drill.type = 'button';
      drill.className = 'link row-drill';
      drill.textContent = '进入 ›';
      drill.addEventListener('click', (event) => { event.stopPropagation(); picker.openSpace(space); });
      row.append(drill);
      item.append(row);
      list.append(item);
    }
  } else {
    for (const node of state.nodes) {
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = `picker-row selectable${node.nodeToken === state.selectedNodeToken ? ' selected' : ''}`;
      // 整行可点（不只文字），下钻按钮阻止冒泡以免误选中
      row.addEventListener('click', () => picker.select(node));
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'row-title';
      title.textContent = node.title || node.nodeToken;
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
        drill.addEventListener('click', (event) => { event.stopPropagation(); picker.openNode(node); });
        row.append(drill);
      }
      item.append(row);
      list.append(item);
    }
  }

  const hasSelection = state.view === 'spaces' ? Boolean(state.selectedSpaceId) : Boolean(state.selectedNodeToken);
  els.save.disabled = state.saving || !hasSelection;
  els.save.textContent = state.saving ? labels.saving : state.view === 'spaces' ? labels.saveSpace : labels.saveNode;
}

export function wirePicker(picker, els) {
  els.back.addEventListener('click', () => picker.back());
  els.retry.addEventListener('click', () => picker.retry());
  els.more.addEventListener('click', () => {
    const state = picker.getState();
    return state.view === 'spaces' ? picker.loadMoreSpaces() : picker.loadMoreNodes();
  });
}
