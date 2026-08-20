// 可视化保存目标选择器的状态控制器。不依赖 DOM 或 chrome API，可在 node:test 下直接测试；
// options.js 只负责把状态渲染到页面并把用户操作转发到这里。

export const PICKER_PAGE_SIZE = 20;

const UNPAIRED_CODES = new Set(['PAIRING_REQUIRED', 'ORIGIN_MISMATCH', 'PAIRING_REPLACED']);

export function classifyPickerError(error) {
  if (error?.code === 'BRIDGE_OFFLINE') return 'offline';
  if (UNPAIRED_CODES.has(error?.code)) return 'unpaired';
  if (error?.code === 'LARK_AUTH_REQUIRED') return 'auth';
  if (error?.code === 'LARK_PERMISSION_DENIED') return 'forbidden';
  return 'failed';
}

export function createTargetPicker({ listSpaces, listNodes, saveDestination, initialDestination = null }) {
  let state = {
    status: 'idle', // idle | loading | ready | error
    error: null, // { kind, message }
    destination: initialDestination,
    view: 'spaces', // spaces | nodes
    crumbs: [], // crumb[0] = { spaceId, title }；之后是 { nodeToken, title }
    spaces: [],
    spacesHasMore: false,
    nodes: [],
    nodesHasMore: false,
    selectedNodeToken: null,
    selectedSpaceId: null,
    saving: false,
    savedTick: 0, // 保存成功后递增，供 UI 提示
  };
  let cursors = { spaces: null, nodes: null };
  const listeners = new Set();

  function emit() {
    for (const listener of listeners) listener(state);
  }

  function patch(partial) {
    state = { ...state, ...partial };
    emit();
  }

  function fail(error) {
    patch({ status: 'error', error: { kind: classifyPickerError(error), message: error?.message || '操作失败' } });
  }

  function currentLevel() {
    if (state.crumbs.length === 0) return null;
    return {
      spaceId: state.crumbs[0].spaceId,
      parentNodeToken: state.crumbs.length > 1 ? state.crumbs[state.crumbs.length - 1].nodeToken : undefined,
    };
  }

  async function loadSpacesPage(cursor = null) {
    const result = await listSpaces({ cursor, limit: PICKER_PAGE_SIZE });
    return {
      spaces: cursor ? [...state.spaces, ...result.spaces] : result.spaces,
      spacesHasMore: result.hasMore && Boolean(result.nextPageToken),
      nextCursor: result.hasMore ? result.nextPageToken : null,
    };
  }

  async function loadNodesPage(level, cursor = null) {
    const result = await listNodes({ ...level, cursor, limit: PICKER_PAGE_SIZE });
    return {
      nodes: cursor ? [...state.nodes, ...result.nodes] : result.nodes,
      nodesHasMore: result.hasMore && Boolean(result.nextPageToken),
      nextCursor: result.hasMore ? result.nextPageToken : null,
    };
  }

  async function run(partial, task) {
    patch({ status: 'loading', error: null, ...partial });
    try {
      const loaded = await task();
      patch({ status: 'ready', ...loaded });
    } catch (error) {
      fail(error);
    }
  }

  const picker = {
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },

    getState() {
      return state;
    },

    async start() {
      await run({ view: 'spaces', crumbs: [], spaces: [], selectedNodeToken: null, selectedSpaceId: null }, async () => {
        const page = await loadSpacesPage();
        cursors.spaces = page.nextCursor;
        return { spaces: page.spaces, spacesHasMore: page.spacesHasMore };
      });
    },

    async retry() {
      // 回到出错前的层级重新加载；不改动已保存的默认目标
      const level = currentLevel();
      if (!level) return picker.start();
      await run({ nodes: [] }, async () => {
        const page = await loadNodesPage(level);
        cursors.nodes = page.nextCursor;
        return { nodes: page.nodes, nodesHasMore: page.nodesHasMore };
      });
    },

    async loadMoreSpaces() {
      if (state.status === 'loading' || !state.spacesHasMore || !cursors.spaces) return;
      await run({}, async () => {
        const page = await loadSpacesPage(cursors.spaces);
        cursors.spaces = page.nextCursor;
        return { spaces: page.spaces, spacesHasMore: page.spacesHasMore };
      });
    },

    async loadMoreNodes() {
      if (state.status === 'loading' || !state.nodesHasMore || !cursors.nodes) return;
      const level = currentLevel();
      if (!level) return;
      await run({}, async () => {
        const page = await loadNodesPage(level, cursors.nodes);
        cursors.nodes = page.nextCursor;
        return { nodes: page.nodes, nodesHasMore: page.nodesHasMore };
      });
    },

    async openSpace(space) {
      const crumbs = [{ spaceId: space.spaceId, title: space.name }];
      await run({ view: 'nodes', crumbs, nodes: [], selectedNodeToken: null, selectedSpaceId: null }, async () => {
        const page = await loadNodesPage({ spaceId: space.spaceId });
        cursors.nodes = page.nextCursor;
        return { nodes: page.nodes, nodesHasMore: page.nodesHasMore };
      });
    },

    async openNode(node) {
      const crumbs = [...state.crumbs, { nodeToken: node.nodeToken, title: node.title }];
      await run({ view: 'nodes', crumbs, nodes: [], selectedNodeToken: null }, async () => {
        const page = await loadNodesPage({ spaceId: state.crumbs[0].spaceId, parentNodeToken: node.nodeToken });
        cursors.nodes = page.nextCursor;
        return { nodes: page.nodes, nodesHasMore: page.nodesHasMore };
      });
    },

    async goToCrumb(index) {
      // index -1 表示回到知识库列表；否则截断到对应层级
      if (index < 0) {
        patch({ view: 'spaces', crumbs: [], nodes: [], nodesHasMore: false, selectedNodeToken: null, status: 'ready', error: null });
        return;
      }
      const crumbs = state.crumbs.slice(0, index + 1);
      const level = {
        spaceId: crumbs[0].spaceId,
        parentNodeToken: crumbs.length > 1 ? crumbs[crumbs.length - 1].nodeToken : undefined,
      };
      await run({ view: 'nodes', crumbs, nodes: [], selectedNodeToken: null }, async () => {
        const page = await loadNodesPage(level);
        cursors.nodes = page.nextCursor;
        return { nodes: page.nodes, nodesHasMore: page.nodesHasMore };
      });
    },

    async back() {
      await picker.goToCrumb(state.crumbs.length - 2);
    },

    select(node) {
      if (state.view !== 'nodes') return;
      patch({ selectedNodeToken: node.nodeToken });
    },

    selectSpace(space) {
      if (state.view !== 'spaces') return;
      patch({ selectedSpaceId: space.spaceId });
    },

    async saveSelection() {
      if (state.saving) return null;
      if (state.view === 'spaces') {
        const space = state.spaces.find((candidate) => candidate.spaceId === state.selectedSpaceId);
        if (!space) return null;
        return picker.saveManual({ kind: 'space', spaceId: space.spaceId, title: space.name, path: [space.name] });
      }
      const node = state.nodes.find((candidate) => candidate.nodeToken === state.selectedNodeToken);
      if (!node) return null;
      const path = state.crumbs.map((crumb) => crumb.title);
      return picker.saveManual({ kind: 'node', nodeToken: node.nodeToken, spaceId: node.spaceId, title: node.title, path });
    },

    async saveManual(destination) {
      if (state.saving) return null;
      patch({ saving: true, error: null });
      try {
        const result = await saveDestination(destination);
        const merged = { ...result.destination, path: destination.path || [result.destination.title] };
        patch({
          saving: false,
          destination: merged,
          savedTick: state.savedTick + 1,
          status: state.status === 'idle' ? 'ready' : state.status,
        });
        return merged;
      } catch (error) {
        // 保存失败不得覆盖原有默认目标
        patch({ saving: false, error: { kind: classifyPickerError(error), message: error?.message || '保存失败' } });
        return null;
      }
    },
  };

  return picker;
}
