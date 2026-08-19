import assert from 'node:assert/strict';
import test from 'node:test';
import { createTargetPicker, classifyPickerError } from '../src/extension/target-picker.js';

function fakeBridge({ spaces = [], nodesByParent = {}, saveResult, failWith } = {}) {
  const saved = [];
  return {
    saved,
    deps: {
      listSpaces: async ({ cursor } = {}) => {
        if (failWith?.spaces) throw failWith.spaces;
        const start = cursor ? spaces.findIndex((space) => space.spaceId === cursor) + 1 : 0;
        const page = spaces.slice(start, start + 2);
        const hasMore = start + 2 < spaces.length;
        return { spaces: page, hasMore, nextPageToken: hasMore ? page[page.length - 1].spaceId : null };
      },
      listNodes: async ({ spaceId, parentNodeToken, cursor } = {}) => {
        if (failWith?.nodes) throw failWith.nodes;
        const key = parentNodeToken || `${spaceId}:root`;
        const all = nodesByParent[key] || [];
        const start = cursor ? all.findIndex((node) => node.nodeToken === cursor) + 1 : 0;
        const page = all.slice(start, start + 2);
        const hasMore = start + 2 < all.length;
        return { nodes: page, hasMore, nextPageToken: hasMore ? page[page.length - 1].nodeToken : null };
      },
      saveDestination: async (destination) => {
        if (failWith?.save) throw failWith.save;
        saved.push(destination);
        return saveResult ? saveResult(destination) : { destination: { nodeToken: destination.nodeToken, spaceId: destination.spaceId, title: '已验证标题', objType: 'docx' } };
      },
    },
  };
}

const spaces = [
  { spaceId: 's1', name: 'Project', spaceType: 'team' },
  { spaceId: 's2', name: 'Area', spaceType: 'team' },
  { spaceId: 's3', name: 'Resource', spaceType: 'team' },
];

const rootNodes = [
  { nodeToken: 'n1', spaceId: 's1', title: '首页', objType: 'docx', hasChildren: true },
  { nodeToken: 'n2', spaceId: 's1', title: '归档', objType: 'docx', hasChildren: false },
  { nodeToken: 'n3', spaceId: 's1', title: '收集箱', objType: 'docx', hasChildren: false },
];

test('loads spaces with pagination and empty state', async () => {
  const { deps } = fakeBridge({ spaces });
  const picker = createTargetPicker({ ...deps });
  await picker.start();
  let state = picker.getState();
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.spaces.map((space) => space.spaceId), ['s1', 's2']);
  assert.equal(state.spacesHasMore, true);
  await picker.loadMoreSpaces();
  state = picker.getState();
  assert.deepEqual(state.spaces.map((space) => space.spaceId), ['s1', 's2', 's3']);
  assert.equal(state.spacesHasMore, false);

  const empty = createTargetPicker({ ...fakeBridge({ spaces: [] }).deps });
  await empty.start();
  assert.equal(empty.getState().status, 'ready');
  assert.equal(empty.getState().spaces.length, 0);
});

test('navigates hierarchy with breadcrumbs, back and node pagination', async () => {
  const childNodes = [{ nodeToken: 'n1a', spaceId: 's1', title: '子文档 A', objType: 'docx', hasChildren: false }];
  const { deps } = fakeBridge({ spaces, nodesByParent: { 's1:root': rootNodes, n1: childNodes } });
  const picker = createTargetPicker({ ...deps });
  await picker.start();

  await picker.openSpace(spaces[0]);
  let state = picker.getState();
  assert.equal(state.view, 'nodes');
  assert.deepEqual(state.crumbs.map((crumb) => crumb.title), ['Project']);
  assert.deepEqual(state.nodes.map((node) => node.nodeToken), ['n1', 'n2']);
  assert.equal(state.nodesHasMore, true);

  await picker.loadMoreNodes();
  state = picker.getState();
  assert.deepEqual(state.nodes.map((node) => node.nodeToken), ['n1', 'n2', 'n3']);
  assert.equal(state.nodesHasMore, false);

  await picker.openNode(rootNodes[0]);
  state = picker.getState();
  assert.deepEqual(state.crumbs.map((crumb) => crumb.title), ['Project', '首页']);
  assert.deepEqual(state.nodes.map((node) => node.nodeToken), ['n1a']);

  await picker.back();
  state = picker.getState();
  assert.deepEqual(state.crumbs.map((crumb) => crumb.title), ['Project']);
  assert.deepEqual(state.nodes.map((node) => node.nodeToken), ['n1', 'n2']);

  await picker.goToCrumb(-1);
  state = picker.getState();
  assert.equal(state.view, 'spaces');
  assert.deepEqual(state.spaces.map((space) => space.spaceId), ['s1', 's2'], 'space list is preserved when going back to root');
});

test('selects a node and saves a full destination summary', async () => {
  const { deps, saved } = fakeBridge({ spaces, nodesByParent: { 's1:root': rootNodes } });
  const picker = createTargetPicker({ ...deps });
  await picker.start();
  await picker.openSpace(spaces[0]);

  assert.equal(await picker.saveSelection(), null, 'nothing to save before selecting');
  picker.select(rootNodes[0]);
  const savedDestination = await picker.saveSelection();
  assert.equal(savedDestination.title, '已验证标题');
  assert.deepEqual(saved, [{ nodeToken: 'n1', spaceId: 's1', title: '首页', path: ['Project'] }]);
  const state = picker.getState();
  assert.deepEqual(state.destination, { nodeToken: 'n1', spaceId: 's1', title: '已验证标题', objType: 'docx', path: ['Project'] });
  assert.equal(state.savedTick, 1);
});

test('failed save keeps the previous default destination', async () => {
  const existing = { nodeToken: 'old', spaceId: 's0', title: '旧目标', path: ['旧'] };
  const failSave = Object.assign(new Error('INVALID_TARGET'), { code: 'INVALID_TARGET' });
  const { deps } = fakeBridge({ spaces, nodesByParent: { 's1:root': rootNodes }, failWith: { save: failSave } });
  const picker = createTargetPicker({ ...deps, initialDestination: existing });
  await picker.start();
  await picker.openSpace(spaces[0]);
  picker.select(rootNodes[1]);
  assert.equal(await picker.saveSelection(), null);
  assert.deepEqual(picker.getState().destination, existing);
  assert.equal(picker.getState().error.kind, 'failed');
});

test('manual fallback uses the same validate-and-save semantics', async () => {
  const { deps, saved } = fakeBridge({});
  const picker = createTargetPicker({ ...deps, initialDestination: null });
  const savedDestination = await picker.saveManual({ nodeToken: 'wikcn-manual', spaceId: 's9' });
  assert.equal(savedDestination.nodeToken, 'wikcn-manual');
  assert.deepEqual(saved, [{ nodeToken: 'wikcn-manual', spaceId: 's9' }]);
  assert.deepEqual(picker.getState().destination.path, ['已验证标题']);
});

test('failure states classify bridge offline, unpaired, auth and forbidden', async () => {
  assert.equal(classifyPickerError(Object.assign(new Error('x'), { code: 'BRIDGE_OFFLINE' })), 'offline');
  assert.equal(classifyPickerError(Object.assign(new Error('x'), { code: 'PAIRING_REQUIRED' })), 'unpaired');
  assert.equal(classifyPickerError(Object.assign(new Error('x'), { code: 'ORIGIN_MISMATCH' })), 'unpaired');
  assert.equal(classifyPickerError(Object.assign(new Error('x'), { code: 'PAIRING_REPLACED' })), 'unpaired');
  assert.equal(classifyPickerError(Object.assign(new Error('x'), { code: 'LARK_AUTH_REQUIRED' })), 'auth');
  assert.equal(classifyPickerError(Object.assign(new Error('x'), { code: 'LARK_PERMISSION_DENIED' })), 'forbidden');
  assert.equal(classifyPickerError(new Error('network weirdness')), 'failed');

  const offline = createTargetPicker({ ...fakeBridge({ failWith: { spaces: Object.assign(new Error('本地 Bridge 未运行'), { code: 'BRIDGE_OFFLINE' }) } }).deps });
  await offline.start();
  assert.equal(offline.getState().status, 'error');
  assert.equal(offline.getState().error.kind, 'offline');

  // 恢复后 retry 重新加载当前层级
  const flaky = { calls: 0 };
  const { deps } = fakeBridge({ spaces });
  const origListSpaces = deps.listSpaces;
  deps.listSpaces = async (params) => {
    flaky.calls += 1;
    if (flaky.calls === 1) throw Object.assign(new Error('x'), { code: 'PAIRING_REQUIRED' });
    return origListSpaces(params);
  };
  const picker = createTargetPicker({ ...deps });
  await picker.start();
  assert.equal(picker.getState().error.kind, 'unpaired');
  await picker.retry();
  assert.equal(picker.getState().status, 'ready');
  assert.equal(picker.getState().spaces.length, 2);
});
