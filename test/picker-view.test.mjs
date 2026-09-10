// picker-view 行点击区域回归测试：整行可点（含空白/hint 区域），「进入 ›」只下钻不选中。
// 仓库约定零依赖测试，这里用手写 mini-DOM（仅覆盖 renderPicker 用到的 DOM API）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPicker } from '../src/extension/picker-view.js';

function makeEl(tag) {
  const el = {
    tag, parent: null, children: [], listeners: {},
    className: '', textContent: '', type: '', disabled: false,
    classList: {
      add(...cs) { el.className = [...new Set([...el.className.split(' ').filter(Boolean), ...cs])].join(' '); },
      remove(...cs) { el.className = el.className.split(' ').filter((c) => c && !cs.includes(c)).join(' '); },
      toggle(c, force) {
        const want = force ?? !el.classList.contains(c);
        if (want) el.classList.add(c); else el.classList.remove(c);
      },
      contains(c) { return el.className.split(' ').includes(c); },
    },
    append(...kids) { for (const k of kids) { if (k && typeof k === 'object') { k.parent = el; el.children.push(k); } } },
    replaceChildren() { el.children = []; },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
  };
  return el;
}

// 派发 click 并沿 parent 链冒泡，支持 stopPropagation
function click(el) {
  let stopped = false;
  const event = { type: 'click', stopPropagation() { stopped = true; } };
  let node = el;
  while (node && !stopped) {
    for (const fn of node.listeners.click ?? []) fn(event);
    node = node.parent;
  }
}

function findByClass(el, cls) {
  const out = [];
  const walk = (n) => {
    if (n.className?.split(' ').includes(cls)) out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(el);
  return out;
}

const LABELS = { saveSpace: '选这个知识库', saveNode: '选这个文档', saving: '保存中…' };

function setup() {
  globalThis.document = { createElement: makeEl, createTextNode: (text) => ({ text }) };
  return {
    status: makeEl('div'), list: makeEl('ul'), crumbs: makeEl('div'),
    more: makeEl('button'), back: makeEl('button'), retry: makeEl('button'), save: makeEl('button'),
  };
}

const SPACES_STATE = {
  view: 'spaces', status: 'ready', error: null,
  spaces: [{ spaceId: 'sp1', name: 'Area', spaceType: 'team' }],
  selectedSpaceId: null, spacesHasMore: false, crumbs: [],
};

const NODES_STATE = {
  view: 'nodes', status: 'ready', error: null,
  nodes: [{ nodeToken: 'n1', title: '剪藏待读', objType: 'docx', hasChildren: true }],
  selectedNodeToken: null, nodesHasMore: false, crumbs: [{ title: 'Area' }],
};

test('spaces：点击行的空白区域（行本体）也选中', () => {
  const els = setup();
  const calls = [];
  const picker = { selectSpace: (s) => calls.push(['select', s.spaceId]), openSpace: (s) => calls.push(['open', s.spaceId]) };
  renderPicker(picker, SPACES_STATE, els, LABELS);
  click(findByClass(els.list, 'picker-row')[0]);
  assert.deepEqual(calls, [['select', 'sp1']]);
});

test('spaces：点击行内 hint 区域也选中', () => {
  const els = setup();
  const calls = [];
  const picker = { selectSpace: (s) => calls.push(['select', s.spaceId]), openSpace: (s) => calls.push(['open', s.spaceId]) };
  renderPicker(picker, SPACES_STATE, els, LABELS);
  click(findByClass(els.list, 'row-hint')[0]);
  assert.deepEqual(calls, [['select', 'sp1']]);
});

test('spaces：点击「进入 ›」只下钻不选中', () => {
  const els = setup();
  const calls = [];
  const picker = { selectSpace: (s) => calls.push(['select', s.spaceId]), openSpace: (s) => calls.push(['open', s.spaceId]) };
  renderPicker(picker, SPACES_STATE, els, LABELS);
  click(findByClass(els.list, 'row-drill')[0]);
  assert.deepEqual(calls, [['open', 'sp1']]);
});

test('nodes：点击行的空白区域也选中，「进入 ›」只下钻不选中', () => {
  const els = setup();
  const calls = [];
  const picker = { select: (n) => calls.push(['select', n.nodeToken]), openNode: (n) => calls.push(['open', n.nodeToken]) };
  renderPicker(picker, NODES_STATE, els, LABELS);
  click(findByClass(els.list, 'picker-row')[0]);
  assert.deepEqual(calls, [['select', 'n1']]);

  calls.length = 0;
  renderPicker(picker, NODES_STATE, els, LABELS);
  click(findByClass(els.list, 'row-drill')[0]);
  assert.deepEqual(calls, [['open', 'n1']]);
});

// ——— Drive 目录 picker 渲染（#66）：直挂树形内核状态（view root/level）———
import { renderDrivePicker } from '../src/extension/picker-view.js';

const DRIVE_LABELS = { saveRoot: '存到根目录', saveFolder: '存到该目录', saving: '验证中…' };

const DRIVE_ROOT_STATE = {
  view: 'root', status: 'ready', error: null, saving: false,
  rootItems: [
    { folderToken: null, name: '我的空间', driveRoot: true },
    { folderToken: 'fld-a', name: '论文', type: 'folder' },
    { folderToken: 'file-1', name: '报告.pdf', type: 'file' },
  ],
  rootHasMore: false, items: [], itemsHasMore: false, crumbs: [], selectedItem: null,
};

const DRIVE_LEVEL_STATE = {
  view: 'level', status: 'ready', error: null, saving: false,
  rootItems: [], rootHasMore: false,
  items: [{ folderToken: 'fld-a1', name: '2026', type: 'folder' }],
  itemsHasMore: false,
  crumbs: [{ folderToken: 'fld-a', title: '论文' }],
  selectedItem: null,
};

test('drive root：整行点击选中根目录行，保存按钮用根目录文案；根目录行无下钻按钮', () => {
  const els = setup();
  const calls = [];
  const picker = { select: (item) => calls.push(['select', item.folderToken]), open: (item) => calls.push(['open', item.folderToken]), getState: () => DRIVE_ROOT_STATE };
  renderDrivePicker(picker, DRIVE_ROOT_STATE, els, DRIVE_LABELS);
  const rows = findByClass(els.list, 'picker-row');
  assert.equal(rows.length, 3);
  click(rows[0]);
  assert.deepEqual(calls, [['select', null]]);
  assert.equal(findByClass(rows[0], 'row-drill').length, 0, '根目录行不可下钻');
  assert.equal(findByClass(rows[1], 'row-drill').length, 1, '文件夹可下钻');

  const selected = { ...DRIVE_ROOT_STATE, selectedItem: DRIVE_ROOT_STATE.rootItems[0] };
  renderDrivePicker(picker, selected, els, DRIVE_LABELS);
  assert.equal(els.save.textContent, '存到根目录');
  assert.equal(els.save.disabled, false);
});

// 文件项置灰（review #66）：不绑点击、无下钻按钮，弱化样式类 + 📄 图标
test('drive 文件行：置灰不可点、无下钻，hint 标注「文件」', () => {
  const els = setup();
  const calls = [];
  const picker = { select: (item) => calls.push(['select', item.folderToken]), open: (item) => calls.push(['open', item.folderToken]), getState: () => DRIVE_ROOT_STATE };
  renderDrivePicker(picker, DRIVE_ROOT_STATE, els, DRIVE_LABELS);
  const rows = findByClass(els.list, 'picker-row');
  const fileRow = rows[2];
  assert.ok(fileRow.className.includes('file-row'), '文件行带弱化样式类');
  assert.ok(!fileRow.className.includes('selectable'));
  click(fileRow);
  click(findByClass(fileRow, 'row-title')[0]);
  assert.deepEqual(calls, [], '文件行点击不触发选中');
  assert.equal(findByClass(fileRow, 'row-drill').length, 0, '文件行无下钻按钮');
  assert.equal(findByClass(fileRow, 'row-title')[0].textContent, '📄 报告.pdf');
  assert.equal(findByClass(fileRow, 'row-hint')[0].textContent, '文件');
  assert.equal(findByClass(rows[1], 'row-hint')[0].textContent, '文件夹');
});

test('drive level：面包屑根层是「我的空间」；「进入 ›」只下钻不选中', () => {
  const els = setup();
  const calls = [];
  const picker = {
    select: (item) => calls.push(['select', item.folderToken]),
    open: (item) => calls.push(['open', item.folderToken]),
    goToCrumb: (index) => calls.push(['crumb', index]),
    getState: () => DRIVE_LEVEL_STATE,
  };
  renderDrivePicker(picker, DRIVE_LEVEL_STATE, els, DRIVE_LABELS);
  assert.equal(els.crumbs.children[0].textContent, '我的空间', '面包屑首段是云盘根层');
  click(els.crumbs.children[0]);
  assert.deepEqual(calls[0], ['crumb', -1], '点根层面包屑回根列表');

  renderDrivePicker(picker, DRIVE_LEVEL_STATE, els, DRIVE_LABELS);
  click(findByClass(els.list, 'row-drill')[0]);
  assert.deepEqual(calls[1], ['open', 'fld-a1']);

  renderDrivePicker(picker, { ...DRIVE_LEVEL_STATE, selectedItem: DRIVE_LEVEL_STATE.items[0] }, els, DRIVE_LABELS);
  assert.equal(els.save.textContent, '存到该目录');
});
