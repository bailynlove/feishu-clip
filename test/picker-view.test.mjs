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
