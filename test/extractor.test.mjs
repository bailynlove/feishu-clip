// frameset 页面提取回归：主文档无 body、正文在同源子 frame 时也要能提取（bug：hovy 主页这类
// 90 年代 frameset 站点提取失败，报「页面没有可读取正文/未提取到足够的正文内容」）。
// 用 vm 跑真实 extractor.js，mini-DOM 构造 frameset 场景——与生产注入同一条入口。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { element, textNode } from './helpers/mini-dom.mjs';

const extractorCode = await readFile(new URL('../src/extension/extractor.js', import.meta.url), 'utf8');

function runExtractor(doc) {
  const context = vm.createContext({
    document: doc,
    location: new URL('https://example.test/'),
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    fetch: async () => { throw new Error('no network in test'); },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    console,
  });
  return vm.runInContext(extractorCode, context);
}

function frameDoc(text) {
  return { body: element('body', [element('p', [textNode(text)])]) };
}

const LONG = '这是一段足够长的正文内容，用来模拟真实页面的主体文本。'.repeat(3);

function framesetDoc(frames) {
  return {
    title: 'frameset 页面',
    body: null, // 真实浏览器中 frameset 文档的 document.body 为 null
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'frame' ? frames : []),
  };
}

test('frameset 页面：从同源子 frame 提取正文', async () => {
  const doc = framesetDoc([
    { getAttribute: () => 'menu.html', contentDocument: frameDoc('菜单') },      // 内容太短，跳过
    { getAttribute: () => 'bio.html', contentDocument: frameDoc(LONG) },
  ]);
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(result.markdown.includes('足够长的正文内容'));
  assert.ok(!result.markdown.includes('菜单'));
});

test('frameset 页面：FRAMESET 里被注入第三方浮层（≥20 字符）也跳过主文档直接走 frame', async () => {
  // 真实案例：Timeline 扩展的 changelog 弹窗 append 到 document.body（即 FRAMESET），
  // 若把 FRAMESET 当正文渲染，注入物超过 20 字符阈值就永远不会回退到 frame
  const junk = element('div', [element('h2', [textNode('Panel')]), element('p', [textNode('Flash Notes 更新日志，这是一段足够长的注入内容。')])]);
  const doc = {
    title: 'frameset 页面',
    body: element('frameset', [junk]), // 真实浏览器 frameset 文档的 body 是 FRAMESET 元素
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'frame' ? [{ getAttribute: () => 'bio.html', contentDocument: frameDoc(LONG) }] : []),
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(result.markdown.includes('足够长的正文内容'));
  assert.ok(!result.markdown.includes('Flash Notes'));
});

test('frameset 页面：跨域/不可读 frame 跳过，全部不可读时报「页面没有可读取正文」', async () => {
  const doc = framesetDoc([{ getAttribute: () => 'x.html', contentDocument: null }]);
  const result = await runExtractor(doc);
  assert.equal(result.error, '页面没有可读取正文');
});

test('普通页面回归：body 内容足够时正常提取，不触发 frameset 回退', async () => {
  const doc = {
    title: '普通页面',
    body: element('body', [element('p', [textNode(LONG)])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(result.markdown.includes('足够长的正文内容'));
});
