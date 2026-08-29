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
    document: { createTextNode: (value) => textNode(value), ...doc },
    location: new URL('https://example.test/'),
    URL,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    fetch: async () => { throw new Error('no network in test'); },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    console,
  });
  return vm.runInContext(extractorCode, context);
}

// img 夹具：candidate() 读 dataset/currentSrc/src/alt，mini-DOM 没有这些，后挂
function img(src, alt = '示意图') {
  const node = element('img');
  node.dataset = {};
  node.src = src;
  node.alt = alt;
  return node;
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

// pre 内图片回归（labuladong 页面）：img 在 <pre> 里时锚点原地替换会变成围栏代码块里的一行文本，
// 导入飞书后落在 code 块（block_type 14）内——bridge 既定位不到也删不掉。锚点必须移出 pre。
test('pre 内的图片：锚点移到代码块外成为独立段落', async () => {
  const doc = {
    title: '代码块里的图片',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('pre', [textNode('const a = 1;\n'), img('https://example.test/in-pre.png')]),
      element('p', [textNode('代码之后的段落')]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  const fence = result.markdown.match(/```\n([\s\S]*?)```/);
  assert.ok(fence, '应有围栏代码块');
  assert.ok(fence[1].includes('const a = 1;'));
  assert.ok(!fence[1].includes('FEISHU_CLIP_IMAGE'), '锚点不得留在代码块内');
  const anchorAt = result.markdown.indexOf('[[FEISHU_CLIP_IMAGE:0]]');
  assert.ok(anchorAt > -1, '锚点仍应存在');
  assert.ok(anchorAt > result.markdown.lastIndexOf('```'), '锚点应排在代码块之后');
});

test('同一 pre 内多张图片：锚点按原顺序依次排在代码块后', async () => {
  const doc = {
    title: '多图代码块',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('pre', [img('https://example.test/1.png'), textNode('const b = 2;'), img('https://example.test/2.png')]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  const first = result.markdown.indexOf('[[FEISHU_CLIP_IMAGE:0]]');
  const second = result.markdown.indexOf('[[FEISHU_CLIP_IMAGE:1]]');
  assert.ok(first > -1 && second > -1, '两个锚点都应在');
  assert.ok(first > result.markdown.lastIndexOf('```') && second > result.markdown.lastIndexOf('```'), '都应在代码块外');
  assert.ok(first < second, '锚点顺序应与图片出现顺序一致');
});

test('嵌套 pre 内的图片：锚点移出最外层 pre', async () => {
  const doc = {
    title: '嵌套代码块',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('pre', [textNode('outer\n'), element('pre', [img('https://example.test/nested.png')])]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  const fence = result.markdown.match(/```\n([\s\S]*?)```/);
  assert.ok(fence && !fence[1].includes('FEISHU_CLIP_IMAGE'), '嵌套场景锚点也不得留在代码块内');
  assert.ok(result.markdown.indexOf('[[FEISHU_CLIP_IMAGE:0]]') > result.markdown.lastIndexOf('```'));
});

test('pre 外的图片：仍在原地替换为锚点', async () => {
  const doc = {
    title: '普通图片',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('p', [textNode('前文'), img('https://example.test/normal.png'), textNode('后文')]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(result.markdown.includes('[[FEISHU_CLIP_IMAGE:0]]'));
  assert.ok(!result.markdown.includes('```'), '普通图片不应产生代码块');
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].source, 'https://example.test/normal.png');
});
