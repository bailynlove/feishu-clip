import assert from 'node:assert/strict';
import test from 'node:test';
import { createTreePicker } from '../src/extension/tree-picker.js';

// 通用（非 wiki）适配器：根层是「盘」，子层是文件夹树；验证内核只依赖注入面协议，
// 不认识任何 wiki 概念（spaceId/nodeToken 不出现在这里）。
function fakeTree({ roots = [], childrenByCrumb = {}, failWith } = {}) {
  const saved = [];
  const calls = { listRoot: [], listChildren: [] };
  const pageOf = (all, cursor) => {
    const start = cursor ? all.findIndex((item) => item.id === cursor) + 1 : 0;
    const page = all.slice(start, start + 2);
    const hasMore = start + 2 < all.length;
    return { items: page, hasMore, nextPageToken: hasMore ? page[page.length - 1].id : null };
  };
  const adapter = {
    listRoot: async ({ cursor, limit }) => {
      calls.listRoot.push({ cursor, limit });
      if (failWith?.root) throw failWith.root;
      return pageOf(roots, cursor);
    },
    listChildren: async ({ crumbs, cursor, limit }) => {
      calls.listChildren.push({ crumbs, cursor, limit });
      if (failWith?.children) throw failWith.children;
      return pageOf(childrenByCrumb[crumbs.map((crumb) => crumb.title).join('/')] || [], cursor);
    },
    isSelectable: (item) => (item.locked ? false : { id: item.id, title: item.title }),
    crumbOf: (item) => (item.isDir ? { id: item.id, title: item.title } : false),
    save: async (destination) => {
      if (failWith?.save) throw failWith.save;
      saved.push(destination);
      return { destination: { ...destination, title: `${destination.title}（已验证）` } };
    },
  };
  return { adapter, saved, calls };
}

const roots = [
  { id: 'r1', title: '我的空间', isDir: true },
  { id: 'r2', title: '共享盘', isDir: true },
  { id: 'r3', title: '归档盘', isDir: true },
];

const r1Children = [
  { id: 'f1', title: '项目', isDir: true },
  { id: 'f2', title: '只读', isDir: true, locked: true },
  { id: 'note', title: '说明.txt', isDir: false },
];

test('adapter drives root listing and pagination through listRoot only', async () => {
  const { adapter, calls } = fakeTree({ roots });
  const picker = createTreePicker({ adapter });
  await picker.start();
  let state = picker.getState();
  assert.equal(state.status, 'ready');
  assert.equal(state.view, 'root');
  assert.deepEqual(state.rootItems.map((item) => item.id), ['r1', 'r2']);
  assert.equal(state.rootHasMore, true);
  assert.deepEqual(calls.listRoot, [{ cursor: null, limit: 20 }]);

  await picker.loadMoreRoot();
  state = picker.getState();
  assert.deepEqual(state.rootItems.map((item) => item.id), ['r1', 'r2', 'r3']);
  assert.equal(state.rootHasMore, false);
  assert.deepEqual(calls.listRoot[1], { cursor: 'r2', limit: 20 });
});

test('drill-down passes adapter-defined crumbs to listChildren; back and crumbs navigate', async () => {
  const { adapter, calls } = fakeTree({
    roots,
    childrenByCrumb: { 我的空间: r1Children, '我的空间/项目': [{ id: 'f1a', title: '子目录', isDir: true }] },
  });
  const picker = createTreePicker({ adapter });
  await picker.start();

  await picker.open(roots[0]);
  let state = picker.getState();
  assert.equal(state.view, 'level');
  assert.deepEqual(state.crumbs, [{ id: 'r1', title: '我的空间' }]);
  assert.deepEqual(state.items.map((item) => item.id), ['f1', 'f2']);
  assert.equal(state.itemsHasMore, true);
  assert.deepEqual(calls.listChildren[0].crumbs, [{ id: 'r1', title: '我的空间' }]);

  await picker.loadMoreChildren();
  state = picker.getState();
  assert.deepEqual(state.items.map((item) => item.id), ['f1', 'f2', 'note']);
  assert.equal(state.itemsHasMore, false);
  assert.deepEqual(calls.listChildren[1], { crumbs: [{ id: 'r1', title: '我的空间' }], cursor: 'f2', limit: 20 });

  await picker.open(r1Children[0]);
  state = picker.getState();
  assert.deepEqual(state.crumbs.map((crumb) => crumb.title), ['我的空间', '项目']);
  assert.deepEqual(calls.listChildren[2].crumbs.map((crumb) => crumb.title), ['我的空间', '项目']);

  await picker.back();
  state = picker.getState();
  assert.deepEqual(state.crumbs.map((crumb) => crumb.title), ['我的空间']);
  assert.deepEqual(state.items.map((item) => item.id), ['f1', 'f2']);

  await picker.goToCrumb(-1);
  state = picker.getState();
  assert.equal(state.view, 'root');
  assert.deepEqual(state.rootItems.map((item) => item.id), ['r1', 'r2'], 'root list is preserved when going back to root');
});

test('crumbOf false makes a row non-drillable', async () => {
  const { adapter, calls } = fakeTree({ roots, childrenByCrumb: { 我的空间: r1Children } });
  const picker = createTreePicker({ adapter });
  await picker.start();
  await picker.open(roots[0]);
  await picker.open(r1Children[2]); // 说明.txt 不是目录
  assert.equal(picker.getState().crumbs.length, 1, 'no crumb pushed for non-drillable item');
  assert.equal(calls.listChildren.length, 1, 'no children fetch attempted');
});

test('isSelectable false makes a row non-selectable; selection saves via adapter save', async () => {
  const { adapter, saved } = fakeTree({ roots, childrenByCrumb: { 我的空间: r1Children } });
  const picker = createTreePicker({ adapter });
  await picker.start();
  await picker.open(roots[0]);

  picker.select(r1Children[1]); // locked
  assert.equal(picker.getState().selectedItem, null);
  assert.equal(await picker.saveSelection(), null);

  picker.select(r1Children[0]);
  const savedDestination = await picker.saveSelection();
  assert.equal(savedDestination.title, '项目（已验证）');
  assert.deepEqual(saved, [{ id: 'f1', title: '项目', path: ['我的空间'] }], 'path defaults to crumb titles');
  assert.equal(picker.getState().savedTick, 1);
});

test('selectable template may carry its own path, overriding crumb-derived path', async () => {
  const { adapter, saved } = fakeTree({ roots });
  adapter.isSelectable = (item) => ({ id: item.id, title: item.title, path: ['快捷方式', item.title] });
  const picker = createTreePicker({ adapter });
  await picker.start();
  picker.select(roots[0]);
  await picker.saveSelection();
  assert.deepEqual(saved[0].path, ['快捷方式', '我的空间']);
});

test('save failure keeps the previous destination and classifies the error', async () => {
  const existing = { id: 'old', title: '旧目标', path: ['旧'] };
  const failure = Object.assign(new Error('denied'), { code: 'LARK_PERMISSION_DENIED' });
  const { adapter } = fakeTree({ roots, failWith: { save: failure } });
  const picker = createTreePicker({ adapter, initialDestination: existing });
  await picker.start();
  picker.select(roots[1]);
  assert.equal(await picker.saveSelection(), null);
  assert.deepEqual(picker.getState().destination, existing);
  assert.equal(picker.getState().error.kind, 'forbidden');
});

test('list failure surfaces classified error and retry reloads the current level', async () => {
  const offline = Object.assign(new Error('本地 Bridge 未运行'), { code: 'BRIDGE_OFFLINE' });
  const flaky = fakeTree({ roots, failWith: { root: offline } });
  const picker = createTreePicker({ adapter: flaky.adapter });
  await picker.start();
  assert.equal(picker.getState().status, 'error');
  assert.equal(picker.getState().error.kind, 'offline');

  flaky.adapter.listRoot = async () => ({ items: roots.slice(0, 2), hasMore: false, nextPageToken: null });
  await picker.retry();
  assert.equal(picker.getState().status, 'ready');
  assert.equal(picker.getState().rootItems.length, 2);

  // 子层出错后 retry 重载当前层级而非回到根层
  const tree = fakeTree({ roots, childrenByCrumb: { 我的空间: r1Children } });
  const nav = createTreePicker({ adapter: tree.adapter });
  await nav.start();
  await nav.open(roots[0]);
  tree.adapter.listChildren = async () => {
    throw Object.assign(new Error('x'), { code: 'PAIRING_REQUIRED' });
  };
  await nav.open(r1Children[0]);
  assert.equal(nav.getState().error.kind, 'unpaired');
  assert.deepEqual(nav.getState().crumbs.map((crumb) => crumb.title), ['我的空间', '项目']);
  tree.adapter.listChildren = async ({ crumbs }) => ({ items: [{ id: 'x', title: '恢复', isDir: false }], hasMore: false, nextPageToken: null });
  await nav.retry();
  assert.equal(nav.getState().status, 'ready');
  assert.deepEqual(nav.getState().items.map((item) => item.id), ['x']);
});

test('subscribe emits current state immediately and on every patch', async () => {
  const { adapter } = fakeTree({ roots });
  const picker = createTreePicker({ adapter });
  const seen = [];
  const unsubscribe = picker.subscribe((state) => seen.push(state.status));
  assert.deepEqual(seen, ['idle']);
  await picker.start();
  assert.deepEqual(seen, ['idle', 'loading', 'ready']);
  unsubscribe();
  picker.select(roots[0]);
  assert.equal(seen.length, 3, 'no emissions after unsubscribe');
});
