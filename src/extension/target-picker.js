// Wiki 保存目标选择器：树形 picker 内核（tree-picker.js）的第一个适配器 + 兼容门面。
// 适配器把 listSpaces/listNodes/saveDestination 映射到内核注入面；门面保持既有调用方
// （options.js、popup-picker.js、picker-view.js 及测试）看到的 API 与状态形状不变——
// 不依赖 DOM 或 chrome API，可在 node:test 下直接测试。

import { createTreePicker, classifyPickerError, PICKER_PAGE_SIZE } from './tree-picker.js';

export { classifyPickerError, PICKER_PAGE_SIZE };

// 树形内核适配器：crumb[0] = { spaceId, title }，之后是 { nodeToken, title }
export function createWikiAdapter({ listSpaces, listNodes, save }) {
  return {
    async listRoot({ cursor, limit }) {
      const result = await listSpaces({ cursor, limit });
      return { items: result.spaces, hasMore: result.hasMore, nextPageToken: result.nextPageToken };
    },

    async listChildren({ crumbs, cursor, limit }) {
      const result = await listNodes({
        spaceId: crumbs[0].spaceId,
        parentNodeToken: crumbs.length > 1 ? crumbs[crumbs.length - 1].nodeToken : undefined,
        cursor,
        limit,
      });
      return { items: result.nodes, hasMore: result.hasMore, nextPageToken: result.nextPageToken };
    },

    // 知识库本身与 wiki 节点都可作为保存目标；space 模板自带 path（[空间名]），
    // node 模板缺省 path，由内核用 crumbs 的标题链路补上
    isSelectable(item, view) {
      if (view === 'root') return { kind: 'space', spaceId: item.spaceId, title: item.name, path: [item.name] };
      return { kind: 'node', nodeToken: item.nodeToken, spaceId: item.spaceId, title: item.title };
    },

    crumbOf(item, view) {
      if (view === 'root') return { spaceId: item.spaceId, title: item.name };
      return { nodeToken: item.nodeToken, title: item.title };
    },

    save,
  };
}

// 内核状态 → 既有 wiki 门面状态（view: spaces | nodes，spaces/nodes 双列表，分视图选中项）
function toWikiState(state) {
  return {
    status: state.status,
    error: state.error,
    destination: state.destination,
    view: state.view === 'root' ? 'spaces' : 'nodes',
    crumbs: state.crumbs,
    spaces: state.rootItems,
    spacesHasMore: state.rootHasMore,
    nodes: state.items,
    nodesHasMore: state.itemsHasMore,
    selectedNodeToken: state.view === 'level' && state.selectedItem ? state.selectedItem.nodeToken ?? null : null,
    selectedSpaceId: state.view === 'root' && state.selectedItem ? state.selectedItem.spaceId ?? null : null,
    saving: state.saving,
    savedTick: state.savedTick,
  };
}

export function createTargetPicker({ listSpaces, listNodes, saveDestination, initialDestination = null }) {
  const kernel = createTreePicker({
    adapter: createWikiAdapter({ listSpaces, listNodes, save: saveDestination }),
    initialDestination,
  });

  return {
    subscribe(listener) {
      return kernel.subscribe((state) => listener(toWikiState(state)));
    },

    getState() {
      return toWikiState(kernel.getState());
    },

    start: () => kernel.start(),
    retry: () => kernel.retry(),
    loadMoreSpaces: () => kernel.loadMoreRoot(),
    loadMoreNodes: () => kernel.loadMoreChildren(),
    openSpace: (space) => kernel.open(space),
    openNode: (node) => kernel.open(node),
    goToCrumb: (index) => kernel.goToCrumb(index),
    back: () => kernel.back(),

    select(node) {
      if (kernel.getState().view !== 'level') return;
      kernel.select(node);
    },

    selectSpace(space) {
      if (kernel.getState().view !== 'root') return;
      kernel.select(space);
    },

    saveSelection: () => kernel.saveSelection(),
    saveManual: (destination) => kernel.saveManual(destination),
  };
}
