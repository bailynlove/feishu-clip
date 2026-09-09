// Drive 目录选择器（#66）：适配器导航/分页/错误分类/保存的端到端覆盖。
// createDrivePicker 直出树形内核（无 wiki 门面），stub 注入 listFolders/validateFolder。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDrivePicker, DRIVE_ROOT_ITEM } from '../src/extension/drive-picker.js';

// 按页 stub：listFolders 记录调用参数；childrenByFolder 以 folderToken 为键。
// fail 是共享可变槽：测试中途改 fail.list/fail.validate 即可让适配器在下次调用时出错
function fakeDrive({ rootFolders = [], childrenByFolder = {}, failWith } = {}) {
  const calls = { listFolders: [], validateFolder: [] };
  const fail = { ...failWith };
  const pageOf = (all, cursor) => {
    const start = cursor ? all.findIndex((item) => item.folderToken === cursor) + 1 : 0;
    const page = all.slice(start, start + 2);
    const hasMore = start + 2 < all.length;
    return { folders: page, hasMore, nextPageToken: hasMore ? page[page.length - 1].folderToken : null };
  };
  const listFolders = async ({ folderToken, cursor, limit }) => {
    calls.listFolders.push({ folderToken, cursor, limit });
    if (fail.list) throw fail.list;
    return pageOf(folderToken ? (childrenByFolder[folderToken] || []) : rootFolders, cursor);
  };
  const validateFolder = async ({ folderToken }) => {
    calls.validateFolder.push({ folderToken });
    if (fail.validate) throw fail.validate;
    return { folderToken: folderToken ?? null, name: folderToken ? `目录 ${folderToken}` : '我的空间' };
  };
  return { listFolders, validateFolder, calls, fail };
}

const rootFolders = [
  { folderToken: 'fld-a', name: '论文' },
  { folderToken: 'fld-b', name: '剪藏待读' },
  { folderToken: 'fld-c', name: '归档' },
];

test('根层 = 合成「我的空间」行 + 根目录文件夹；listFolders 不带 folderToken', async () => {
  const drive = fakeDrive({ rootFolders });
  const picker = createDrivePicker(drive);
  await picker.start();
  const state = picker.getState();
  assert.equal(state.status, 'ready');
  assert.equal(state.view, 'root');
  assert.deepEqual(state.rootItems.map((item) => item.folderToken), [null, 'fld-a', 'fld-b'], '根目录行在首位');
  assert.equal(state.rootItems[0], DRIVE_ROOT_ITEM);
  assert.equal(state.rootHasMore, true);
  assert.deepEqual(drive.calls.listFolders, [{ folderToken: undefined, cursor: null, limit: 20 }]);

  await picker.loadMoreRoot();
  const more = picker.getState();
  assert.deepEqual(more.rootItems.map((item) => item.folderToken), [null, 'fld-a', 'fld-b', 'fld-c'], '分页页不重复合成根目录行');
  assert.equal(more.rootHasMore, false);
  assert.deepEqual(drive.calls.listFolders[1], { folderToken: undefined, cursor: 'fld-b', limit: 20 });
});

test('文件夹可下钻：crumb 带 folderToken；面包屑回跳保留根列表', async () => {
  const drive = fakeDrive({
    rootFolders,
    childrenByFolder: {
      'fld-a': [{ folderToken: 'fld-a1', name: '2026' }],
      'fld-a1': [],
    },
  });
  const picker = createDrivePicker(drive);
  await picker.start();

  await picker.open(picker.getState().rootItems[1]); // 论文
  let state = picker.getState();
  assert.equal(state.view, 'level');
  assert.deepEqual(state.crumbs, [{ folderToken: 'fld-a', title: '论文' }]);
  assert.deepEqual(state.items.map((item) => item.folderToken), ['fld-a1']);
  assert.deepEqual(drive.calls.listFolders[1], { folderToken: 'fld-a', cursor: null, limit: 20 });

  await picker.open(state.items[0]); // 2026（空目录）
  state = picker.getState();
  assert.deepEqual(state.crumbs.map((crumb) => crumb.title), ['论文', '2026']);
  assert.equal(state.items.length, 0);

  await picker.goToCrumb(-1);
  state = picker.getState();
  assert.equal(state.view, 'root');
  assert.deepEqual(state.rootItems.map((item) => item.folderToken), [null, 'fld-a', 'fld-b'], '回根层不重拉列表');
});

test('合成根目录行不可下钻', async () => {
  const drive = fakeDrive({ rootFolders });
  const picker = createDrivePicker(drive);
  await picker.start();
  await picker.open(picker.getState().rootItems[0]);
  assert.equal(picker.getState().view, 'root', '根目录行不产生 crumb');
  assert.equal(drive.calls.listFolders.length, 1, '不发起子层请求');
});

test('选中根目录行保存：validateFolder(null) 合法通过，destination.folderToken 为 null', async () => {
  const drive = fakeDrive({ rootFolders });
  const picker = createDrivePicker(drive);
  await picker.start();
  picker.select(picker.getState().rootItems[0]);
  const saved = await picker.saveSelection();
  assert.deepEqual(drive.calls.validateFolder, [{ folderToken: null }]);
  assert.deepEqual(saved, { folderToken: null, title: '我的空间', path: ['我的空间'] });
});

test('选中子层文件夹保存：path 由面包屑标题链路补上，title 以验证结果为准', async () => {
  const drive = fakeDrive({ rootFolders, childrenByFolder: { 'fld-a': [{ folderToken: 'fld-a1', name: '2026' }] } });
  const picker = createDrivePicker(drive);
  await picker.start();
  await picker.open(picker.getState().rootItems[1]);
  picker.select(picker.getState().items[0]);
  const saved = await picker.saveSelection();
  assert.deepEqual(drive.calls.validateFolder, [{ folderToken: 'fld-a1' }]);
  assert.equal(saved.folderToken, 'fld-a1');
  assert.equal(saved.title, '目录 fld-a1', '展示名以 validateFolder 返回为准');
  assert.deepEqual(saved.path, ['论文'], 'path 缺省 = crumbs 标题链路');
});

test('手贴 token 路径：saveManual 直达验证，根目录（null）同样合法', async () => {
  const drive = fakeDrive({ rootFolders });
  const picker = createDrivePicker(drive);
  await picker.start();
  const manual = await picker.saveManual({ folderToken: 'fld-manual', title: 'fld-manual' });
  assert.equal(manual.folderToken, 'fld-manual');
  assert.equal(manual.title, '目录 fld-manual');
  assert.deepEqual(manual.path, ['目录 fld-manual'], '无 crumbs 时 path 回退验证后的 title');

  const root = await picker.saveManual({ folderToken: null, title: '我的空间', path: ['我的空间'] });
  assert.equal(root.folderToken, null);
  assert.deepEqual(drive.calls.validateFolder, [{ folderToken: 'fld-manual' }, { folderToken: null }]);
});

test('列举失败按错误分类呈现，retry 重载当前层级', async () => {
  const offline = Object.assign(new Error('本地 Bridge 未运行'), { code: 'BRIDGE_OFFLINE' });
  const drive = fakeDrive({ rootFolders, failWith: { list: offline } });
  const picker = createDrivePicker(drive);
  await picker.start();
  assert.equal(picker.getState().error.kind, 'offline');

  drive.fail.list = null;
  await picker.retry();
  assert.equal(picker.getState().status, 'ready');
  assert.equal(picker.getState().rootItems[0], DRIVE_ROOT_ITEM, '重试后根目录行仍在首位');

  const auth = Object.assign(new Error('飞书用户未登录或授权已失效'), { code: 'LARK_AUTH_REQUIRED' });
  const deeper = fakeDrive({ rootFolders });
  const nav = createDrivePicker(deeper);
  await nav.start();
  deeper.fail.list = auth;
  await nav.open(nav.getState().rootItems[1]);
  assert.equal(nav.getState().error.kind, 'auth', 'LARK_AUTH_REQUIRED 类错误归类为 auth');
});

test('token 失效（validate 拒绝）报错且不覆盖已保存目录，可重选', async () => {
  const invalid = Object.assign(new Error('目录不存在或已删除'), { code: 'INVALID_TARGET' });
  const existing = { folderToken: null, title: '我的空间', path: ['我的空间'] };
  const withInitial = createDrivePicker({ ...fakeDrive({ rootFolders, failWith: { validate: invalid } }), initialDestination: existing });
  await withInitial.start();
  withInitial.select(withInitial.getState().rootItems[1]);
  assert.equal(await withInitial.saveSelection(), null, '验证失败不落库');
  assert.deepEqual(withInitial.getState().destination, existing, '保留原目录');
  assert.equal(withInitial.getState().error.kind, 'failed');

  // 恢复后可重选成功
  const recovered = fakeDrive({ rootFolders });
  const ok = createDrivePicker(recovered);
  await ok.start();
  ok.select(ok.getState().rootItems[2]);
  const saved = await ok.saveSelection();
  assert.equal(saved.folderToken, 'fld-b');
});

test('子层分页：loadMoreChildren 携带 cursor 续接', async () => {
  const drive = fakeDrive({
    rootFolders: [rootFolders[0]],
    childrenByFolder: { 'fld-a': [
      { folderToken: 'f1', name: '一' },
      { folderToken: 'f2', name: '二' },
      { folderToken: 'f3', name: '三' },
    ] },
  });
  const picker = createDrivePicker(drive);
  await picker.start();
  await picker.open(picker.getState().rootItems[1]);
  let state = picker.getState();
  assert.deepEqual(state.items.map((item) => item.folderToken), ['f1', 'f2']);
  assert.equal(state.itemsHasMore, true);

  await picker.loadMoreChildren();
  state = picker.getState();
  assert.deepEqual(state.items.map((item) => item.folderToken), ['f1', 'f2', 'f3']);
  assert.equal(state.itemsHasMore, false);
  assert.deepEqual(drive.calls.listFolders[2], { folderToken: 'fld-a', cursor: 'f2', limit: 20 });
});
