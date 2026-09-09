// 树形 picker 内核：面包屑下钻、分页、选中、保存/验证的通用状态机。不依赖 DOM 或 chrome API，
// 可在 node:test 下直接测试。数据源通过适配器对象注入（wiki 适配器见 target-picker.js，
// drive 适配器规划见 #66）：
//   listRoot({ cursor, limit })             → { items, hasMore, nextPageToken }
//   listChildren({ crumbs, cursor, limit }) → 同上；crumbs 为当前下钻路径（适配器自定义 crumb，需含 title）
//   isSelectable(item, view)                → 保存目标模板 | false（truthy 即整行可选中；模板可自带 path，
//                                             缺省时内核用 crumbs 的 title 链路补上）
//   crumbOf(item, view)                     → 下钻入栈的 crumb | false（不可下钻）
//   save(destination)                       → { destination }（落库还是只验证由调用方决定）

export const PICKER_PAGE_SIZE = 20;

const UNPAIRED_CODES = new Set(['PAIRING_REQUIRED', 'ORIGIN_MISMATCH', 'PAIRING_REPLACED']);

export function classifyPickerError(error) {
  if (error?.code === 'BRIDGE_OFFLINE') return 'offline';
  if (UNPAIRED_CODES.has(error?.code)) return 'unpaired';
  if (error?.code === 'LARK_AUTH_REQUIRED') return 'auth';
  if (error?.code === 'LARK_PERMISSION_DENIED') return 'forbidden';
  return 'failed';
}

export function createTreePicker({ adapter, initialDestination = null }) {
  let state = {
    status: 'idle', // idle | loading | ready | error
    error: null, // { kind, message }
    destination: initialDestination,
    view: 'root', // root | level
    crumbs: [], // 适配器自定义 crumb 对象的栈，至少含 title
    rootItems: [],
    rootHasMore: false,
    items: [],
    itemsHasMore: false,
    selectedItem: null, // 当前列表中被选中的条目引用
    saving: false,
    savedTick: 0, // 保存成功后递增，供 UI 提示
  };
  let cursors = { root: null, children: null };
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

  async function loadRootPage(cursor = null) {
    const result = await adapter.listRoot({ cursor, limit: PICKER_PAGE_SIZE });
    return {
      rootItems: cursor ? [...state.rootItems, ...result.items] : result.items,
      rootHasMore: result.hasMore && Boolean(result.nextPageToken),
      nextCursor: result.hasMore ? result.nextPageToken : null,
    };
  }

  async function loadChildrenPage(cursor = null) {
    const result = await adapter.listChildren({ crumbs: state.crumbs, cursor, limit: PICKER_PAGE_SIZE });
    return {
      items: cursor ? [...state.items, ...result.items] : result.items,
      itemsHasMore: result.hasMore && Boolean(result.nextPageToken),
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
      await run({ view: 'root', crumbs: [], rootItems: [], items: [], selectedItem: null }, async () => {
        const page = await loadRootPage();
        cursors.root = page.nextCursor;
        return { rootItems: page.rootItems, rootHasMore: page.rootHasMore };
      });
    },

    async retry() {
      // 回到出错前的层级重新加载；不改动已保存的默认目标
      if (state.crumbs.length === 0) return picker.start();
      await run({ items: [] }, async () => {
        const page = await loadChildrenPage();
        cursors.children = page.nextCursor;
        return { items: page.items, itemsHasMore: page.itemsHasMore };
      });
    },

    async loadMoreRoot() {
      if (state.status === 'loading' || !state.rootHasMore || !cursors.root) return;
      await run({}, async () => {
        const page = await loadRootPage(cursors.root);
        cursors.root = page.nextCursor;
        return { rootItems: page.rootItems, rootHasMore: page.rootHasMore };
      });
    },

    async loadMoreChildren() {
      if (state.status === 'loading' || !state.itemsHasMore || !cursors.children) return;
      if (state.crumbs.length === 0) return;
      await run({}, async () => {
        const page = await loadChildrenPage(cursors.children);
        cursors.children = page.nextCursor;
        return { items: page.items, itemsHasMore: page.itemsHasMore };
      });
    },

    async open(item) {
      const crumb = adapter.crumbOf(item, state.view);
      if (!crumb) return;
      await run({ view: 'level', crumbs: [...state.crumbs, crumb], items: [], selectedItem: null }, async () => {
        const page = await loadChildrenPage();
        cursors.children = page.nextCursor;
        return { items: page.items, itemsHasMore: page.itemsHasMore };
      });
    },

    async goToCrumb(index) {
      // index -1 表示回到根层列表；否则截断到对应层级
      if (index < 0) {
        patch({ view: 'root', crumbs: [], items: [], itemsHasMore: false, selectedItem: null, status: 'ready', error: null });
        return;
      }
      const crumbs = state.crumbs.slice(0, index + 1);
      await run({ view: 'level', crumbs, items: [], selectedItem: null }, async () => {
        const page = await loadChildrenPage();
        cursors.children = page.nextCursor;
        return { items: page.items, itemsHasMore: page.itemsHasMore };
      });
    },

    async back() {
      await picker.goToCrumb(state.crumbs.length - 2);
    },

    select(item) {
      if (!adapter.isSelectable(item, state.view)) return;
      patch({ selectedItem: item });
    },

    async saveSelection() {
      if (state.saving || !state.selectedItem) return null;
      const template = adapter.isSelectable(state.selectedItem, state.view);
      if (!template) return null;
      const destination = { ...template, path: template.path || state.crumbs.map((crumb) => crumb.title) };
      return picker.saveManual(destination);
    },

    async saveManual(destination) {
      if (state.saving) return null;
      patch({ saving: true, error: null });
      try {
        const result = await adapter.save(destination);
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
