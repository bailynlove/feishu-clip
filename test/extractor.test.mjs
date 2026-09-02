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
    document: { createTextNode: (value) => textNode(value), createElement: (tag) => (tag === 'canvas' ? fakeCompositeCanvas() : element(tag)), ...doc },
    location: new URL('https://example.test/'),
    URL,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    fetch: async () => { throw new Error('no network in test'); },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    console,
  });
  return vm.runInContext(extractorCode, context);
}

// extractor 里 document.createElement('canvas') 的合成画布夹具：
// 只需白底 fillRect/逐层 drawImage/toDataURL 三个动作，像素检查读的是源图层自己的 context
function fakeCompositeCanvas() {
  return {
    width: 0, height: 0,
    getContext: () => ({ fillStyle: null, fillRect() {}, drawImage() {} }),
    toDataURL: () => `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`,
  };
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

// 图片尺寸回归（langgraph 文档剪藏图片全部 100x100）：飞书建图片块需要原始宽高，
// extractor 必须从 img 的 naturalWidth/naturalHeight 带出尺寸给 bridge 用
test('图片记录 naturalWidth/naturalHeight 作为原始尺寸', async () => {
  const sized = img('https://example.test/sized.png');
  sized.naturalWidth = 4572;
  sized.naturalHeight = 2047;
  const doc = {
    title: '带尺寸的图片',
    body: element('body', [element('p', [textNode(LONG)]), element('p', [sized])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.images[0].width, 4572);
  assert.equal(result.images[0].height, 2047);
});

test('图片未加载完成（naturalWidth 为 0/缺失）时不带尺寸字段', async () => {
  const unloaded = img('https://example.test/unloaded.png');
  unloaded.naturalWidth = 0; // 浏览器中未解码完成的图片 naturalWidth 为 0
  unloaded.naturalHeight = 0;
  const doc = {
    title: '无尺寸的图片',
    body: element('body', [element('p', [textNode(LONG)]), element('p', [unloaded]), element('p', [img('https://example.test/plain.png')])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal('width' in result.images[0], false, 'naturalWidth 为 0 时不应带 width');
  assert.equal('height' in result.images[0], false);
  assert.equal('width' in result.images[1], false, '属性缺失时也不应带 width');
});

// 隐藏图片回归（labuladong 页面）：代码行内的 hover 提示图（span.code-extend-content 默认
// display:none，悬停才显示）嵌在 pre 里，原页面不可见却被提取；又因 pre 锚点规则被移到
// 最后一个代码块之后，剪藏文档末尾凭空多出两张图。未渲染（无布局盒）的图片必须跳过。
test('display:none 容器内的图片：不提取、不产生锚点', async () => {
  const hidden = img('https://example.test/hidden.png');
  hidden.getClientRects = () => []; // display:none 子树内的元素没有布局盒
  const visibleImg = img('https://example.test/visible.png');
  visibleImg.getClientRects = () => [{ width: 100, height: 100 }];
  const doc = {
    title: '隐藏图片',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('pre', [textNode('const c = 3;\n'), hidden]),
      element('p', [visibleImg]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.images.length, 1, '隐藏图片不应进入 images');
  assert.equal(result.images[0].source, 'https://example.test/visible.png');
  assert.ok(!result.markdown.includes('hidden.png') && !result.markdown.includes('[[FEISHU_CLIP_IMAGE:1]]'), '隐藏图片不应产生锚点');
});

// 悬浮内容（labuladong 代码行内的灯泡 hover 面板，span.code-extend-content 默认 display:none）：
// 用户在原页面悬停时能看到这些内容，剪藏直接丢弃可惜、混进正文又无标注。约定：在悬浮触发位置
// 留 `悬浮内容{i}` 标记，真正的内容作为注释段落 `悬浮内容{i}: 内容` 排到所在块（如代码块）之后。
function hoverPanel(content) {
  const node = element('span', [textNode(content)]);
  node.getClientRects = () => []; // display:none 子树没有布局盒，悬停才显示
  return node;
}

test('pre 内悬浮面板：标记留在代码块内原位，注释排在代码块后', async () => {
  const panel = hoverPanel('拓扑排序两种实现：BFS 基于入度，DFS 基于后序遍历逆序。');
  const doc = {
    title: '悬浮内容',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('pre', [textNode('def topo_sort():\n    pass\n'), panel]),
      element('p', [textNode('代码之后的段落')]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  const fence = result.markdown.match(/```\n([\s\S]*?)```/);
  assert.ok(fence, '应有围栏代码块');
  assert.ok(fence[1].includes('悬浮内容1'), '标记应留在悬浮触发位置（代码块内）');
  assert.ok(!fence[1].includes('拓扑排序两种实现'), '悬浮内容本身不应混进代码块文本');
  const note = result.markdown.indexOf('悬浮内容1: 拓扑排序两种实现');
  assert.ok(note > result.markdown.lastIndexOf('```'), '注释应排在代码块之后');
  assert.equal(panel.getAttribute('data-feishu-clip-hover'), null, '提取后应清理原页面上的打标属性');
});

test('同一代码块多个悬浮面板：标记与注释都按出现顺序编号排列', async () => {
  const doc = {
    title: '多悬浮面板',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('pre', [
        textNode('line1\n'), hoverPanel('第一个面板的讲解内容'),
        textNode('line2\n'), hoverPanel('第二个面板的讲解内容'),
      ]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  const fence = result.markdown.match(/```\n([\s\S]*?)```/);
  assert.ok(fence[1].indexOf('悬浮内容1') > -1 && fence[1].indexOf('悬浮内容1') < fence[1].indexOf('悬浮内容2'), '标记应按原顺序编号');
  const note1 = result.markdown.indexOf('悬浮内容1: 第一个面板');
  const note2 = result.markdown.indexOf('悬浮内容2: 第二个面板');
  assert.ok(note1 > result.markdown.lastIndexOf('```') && note2 > note1, '注释应按序排在代码块后');
});

test('普通段落内的悬浮面板：注释排在该段落之后', async () => {
  const doc = {
    title: '段落悬浮',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('p', [textNode('前文'), hoverPanel('对前文术语的补充解释内容'), textNode('后文')]),
      element('p', [textNode('下一段落内容')]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  const markerAt = result.markdown.indexOf('前文悬浮内容1后文');
  const noteAt = result.markdown.indexOf('悬浮内容1: 对前文术语的补充解释内容');
  const nextPara = result.markdown.indexOf('下一段落内容');
  assert.ok(markerAt > -1, '标记应留在段落原位');
  assert.ok(noteAt > markerAt && noteAt < nextPara, '注释应紧跟所在段落之后、下一段之前');
});

test('隐藏但文本过短（<2 字符）的容器不当作悬浮内容', async () => {
  const dot = element('span', [textNode('·')]);
  dot.getClientRects = () => [];
  const doc = {
    title: '无文本隐藏容器',
    body: element('body', [element('p', [textNode(LONG), dot])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('悬浮内容'), '不应产生悬浮标记或注释');
});

// 纯图片悬浮面板（labuladong 的实际形态：.code-extend-content 里只有一张示意图，无文字）：
// 图片作为该面板的内容保留——按面板编号标注、锚点移到所在代码块后，而不是像 0.1.1 那样直接丢弃。
test('纯图片悬浮面板：图片提取并按面板编号标注，锚点排在代码块后', async () => {
  const panel = element('span', []);
  panel.getClientRects = () => [];
  const hiddenImg = img('https://example.test/panel-only.png', '');
  hiddenImg.getClientRects = () => [];
  panel.append(hiddenImg);
  const doc = {
    title: '纯图片悬浮面板',
    body: element('body', [element('p', [textNode(LONG)]), element('pre', [textNode('def f():\n'), panel]), element('p', [textNode('后续段落')])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.images.length, 1, '面板内的图片应作为悬浮内容保留');
  assert.equal(result.images[0].label, '悬浮内容1');
  const fence = result.markdown.match(/```\n([\s\S]*?)```/);
  assert.ok(fence[1].includes('悬浮内容1'), '触发位置应留标记');
  const anchorAt = result.markdown.indexOf('[[FEISHU_CLIP_IMAGE:0]]');
  assert.ok(anchorAt > result.markdown.lastIndexOf('```'), '图片锚点应排在代码块之后');
  assert.ok(!result.markdown.includes('悬浮内容1:'), '无文字的面板不应产生空注释');
  // 纯图片面板没有文字注释，图片直接出现在代码块后，文档里看不出是哪条悬浮内容：
  // 锚点前要有编号标签段（独立段落，不与锚点同段，否则 bridge 定位不到独立锚点块）
  const labelAt = result.markdown.indexOf('悬浮内容1：');
  assert.ok(labelAt > result.markdown.lastIndexOf('```'), '编号标签应排在代码块之后');
  assert.ok(labelAt > -1 && labelAt < anchorAt, '编号标签应紧挨图片锚点之前');
});

test('悬浮面板内既有文字又有图片：注释和图片都按编号保留', async () => {
  const panel = hoverPanel('带示意图的悬浮讲解内容');
  const hiddenImg = img('https://example.test/panel-inner.png', '');
  hiddenImg.getClientRects = () => [];
  panel.append(hiddenImg);
  const doc = {
    title: '悬浮面板带图',
    body: element('body', [element('p', [textNode(LONG)]), element('pre', [textNode('code\n'), panel])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].label, '悬浮内容1');
  assert.ok(result.markdown.includes('悬浮内容1: 带示意图的悬浮讲解内容'), '面板文字应作为注释保留');
});

test('display:none 散图（不在悬浮面板内）仍不提取', async () => {
  const lone = img('https://example.test/lone-hidden.png');
  lone.getClientRects = () => [];
  const doc = {
    title: '散落的隐藏图',
    body: element('body', [element('p', [textNode(LONG)]), element('div', [lone])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.images.length, 0);
  assert.ok(!result.markdown.includes('悬浮内容'));
});

// 公式误判回归（labuladong 并查集页面）：KaTeX 的 math > semantics > annotation 存 TeX 源码，
// 浏览器 UA 样式对 annotation display:none（无布局盒），被悬浮检测误打标——正文出现
// 「O(1)悬浮内容1O(1)」、段落末尾跟着「悬浮内容1: O(1)」。MathML 子树永远不是悬浮内容。
test('KaTeX 公式的 MathML annotation（TeX 源码，display:none）不误判为悬浮内容', async () => {
  const annotation = element('annotation', [textNode('O(1)')]);
  annotation.getClientRects = () => []; // annotation 不渲染，无布局盒
  const math = element('math', [element('semantics', [element('mrow', [textNode('O(1)')]), annotation])]);
  const katex = element('span', [
    element('span', [math]), // .katex-mathml，视觉隐藏但有 1px 布局盒
    element('span', [textNode('O(1)')]), // .katex-html，可见副本
  ]);
  const doc = {
    title: '公式页面',
    body: element('body', [element('p', [textNode(LONG), textNode(' 可以在 '), katex, textNode(' 时间内合并')])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('悬浮内容'), '公式不得产生悬浮标记或注释');
});

test('同一块的多个悬浮注释：每条各自占一段（换行分隔）', async () => {
  const doc = {
    title: '多注释换行',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('pre', [
        textNode('line1\n'), hoverPanel('第一个面板的讲解内容'),
        textNode('line2\n'), hoverPanel('第二个面板的讲解内容'),
      ]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.match(result.markdown, /悬浮内容1: 第一个面板的讲解内容\n\n悬浮内容2: 第二个面板的讲解内容/, '注释应各自成段，不得连在一行');
});

// iframe 提取（#47）：正文里的 iframe（如 labuladong 折叠 details 里的算法可视化面板）不再被
// 当垃圾清除，快照带出 url/title，正文原位留 [[FEISHU_CLIP_IFRAME:i]] 占位符供 bridge 转写。
function iframe(src, title = '') {
  const node = element('iframe');
  if (src !== null) node.setAttribute('src', src);
  if (title) node.setAttribute('title', title);
  return node;
}

test('正文 iframe：快照带出 url/title，原位留占位符', async () => {
  const doc = {
    title: 'iframe 页面',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('p', [textNode('算法可视化')]),
      element('details', [iframe('https://example.test/algo-visualize/uf/', '算法可视化 - uf')]),
      element('p', [textNode('后续内容')]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  // vm 跨域对象与测试侧原型不同，不能用 deepEqual，逐字段断言
  assert.equal(result.iframes.length, 1);
  assert.equal(result.iframes[0].url, 'https://example.test/algo-visualize/uf/');
  assert.equal(result.iframes[0].title, '算法可视化 - uf');
  const anchorAt = result.markdown.indexOf('[[FEISHU_CLIP_IFRAME:0]]');
  assert.ok(anchorAt > result.markdown.indexOf('算法可视化') && anchorAt < result.markdown.indexOf('后续内容'), '占位符应在 iframe 原位');
});

test('iframe src 为相对路径时按页面 URL resolve', async () => {
  const doc = {
    title: '相对 src',
    body: element('body', [element('p', [textNode(LONG)]), iframe('/widget/demo/', '')]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.iframes[0].url, 'https://example.test/widget/demo/');
  assert.equal(result.iframes[0].title, 'iframe 1', '无 title 时用默认标注');
});

test('无 src / 非 http(s) / 跟踪尺寸（≤2px）的 iframe 跳过', async () => {
  const noSrc = iframe(null);
  const jsSrc = iframe('javascript:void(0)');
  const tiny = iframe('https://example.test/pixel');
  tiny.getBoundingClientRect = () => ({ width: 1, height: 1 }); // 跟踪像素
  const doc = {
    title: '脏 iframe',
    body: element('body', [element('p', [textNode(LONG)]), noSrc, jsSrc, tiny]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.iframes.length, 0);
  assert.ok(!result.markdown.includes('FEISHU_CLIP_IFRAME'), '跳过的 iframe 不留占位符');
});

test('iframe 超过 10 个时只保留前 10 个', async () => {
  const iframes = Array.from({ length: 12 }, (_, i) => iframe(`https://example.test/w${i}/`, `w${i}`));
  const doc = {
    title: '大量 iframe',
    body: element('body', [element('p', [textNode(LONG)]), ...iframes]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.iframes.length, 10);
  assert.ok(result.markdown.includes('[[FEISHU_CLIP_IFRAME:9]]'));
  assert.ok(!result.markdown.includes('[[FEISHU_CLIP_IFRAME:10]]'));
});

// 折叠 details 里的 iframe（labuladong 可视化面板的真实形态）未渲染，getBoundingClientRect 全零；
// 0x0 不等于跟踪像素（跟踪像素是渲染出来的 1-2px 小点），必须保留
test('折叠 details 内 0x0 的 iframe 保留', async () => {
  const collapsed = iframe('https://example.test/algo-visualize/uf/', '算法可视化');
  collapsed.getBoundingClientRect = () => ({ width: 0, height: 0 });
  const doc = {
    title: '折叠面板',
    body: element('body', [element('p', [textNode(LONG)]), element('details', [collapsed])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.iframes.length, 1);
  assert.equal(result.iframes[0].url, 'https://example.test/algo-visualize/uf/');
});

// code-review 发现的边界：iframe 直接挂在 details 下、与 summary 文本混排时，文本节点占位符的
// \n\n 会被 render 压成空格，占位符糊进 summary 段落，bridge 定位不到独立锚点块。占位符必须
// 用 P 元素，保证任何父容器下都独立成段
test('iframe 与 summary 文本同在 details 内：占位符仍独立成段', async () => {
  const doc = {
    title: 'details 混排',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('details', [element('summary', [textNode('算法可视化')]), iframe('https://example.test/viz/', '演示')]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  const line = result.markdown.split('\n').find((l) => l.includes('FEISHU_CLIP_IFRAME'));
  assert.equal(line?.trim(), '[[FEISHU_CLIP_IFRAME:0]]', '占位符应独立成行，不得混入 summary 文本');
});

// 同为 code-review 边界：折叠容器里既有文本又有 iframe 时，若被悬浮打标，iframe 占位符会随
// 面板一起被替换成标记——快照有 iframes 条目但正文没占位符。含 iframe 的隐藏容器不打标
test('含 iframe 的隐藏容器不作悬浮打标，iframe 占位符保留', async () => {
  const panel = element('div', [textNode('折叠起来的补充说明文字'), iframe('https://example.test/viz2/', '面板')]);
  panel.getClientRects = () => []; // 折叠 details 内容，无布局盒
  const doc = {
    title: '隐藏容器带 iframe',
    body: element('body', [element('p', [textNode(LONG)]), element('details', [panel])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.iframes.length, 1, 'iframe 仍应提取');
  assert.ok(result.markdown.includes('[[FEISHU_CLIP_IFRAME:0]]'), '占位符不应被悬浮标记吞掉');
  assert.ok(!result.markdown.includes('悬浮内容'), '含 iframe 的容器不应产生悬浮标记');
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

// Medium 页面噪声（#50）：
// 1) 页头点赞/收藏等动作按钮是只包图标的 <a>，图标被清理后链接文字为空，
//    旧代码 `children().trim() || href` 回退把裸 URL 当文字输出，文档开头混入 signin 长链
// 2) 图片上的 "Press enter or click to view image in full size" 是 Medium 放在
//    div[role=button] 里的控件提示文字（span 与包 img 的 div 并列），不是正文
test('空文字链接（图标按钮类）跳过，不回退输出裸 URL', async () => {
  const iconLink = element('a', [element('div', [element('span', [])])]);
  iconLink.setAttribute('href', 'https://medium.com/m/signin?actionUrl=x');
  const textLink = element('a', [textNode('原文链接')]);
  textLink.setAttribute('href', 'https://example.test/page');
  const doc = {
    title: '链接过滤',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('p', [iconLink, textLink]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('signin'), '空文字链接不得回退输出裸 URL');
  assert.ok(result.markdown.includes('[原文链接](https://example.test/page)'), '有文字的链接不受影响');
});

test('role=button 内的控件提示文字不进入正文，按钮内图片锚点保留', async () => {
  const button = element('div', [
    element('span', [textNode('Press enter or click to view image in full size')]),
    element('div', [img('https://example.test/medium.png')]),
  ]);
  button.setAttribute('role', 'button');
  const doc = {
    title: '图片按钮',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('figure', [button]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('Press enter'), '控件提示文字不应进入正文');
  assert.ok(result.markdown.includes('[[FEISHU_CLIP_IMAGE:0]]'), '按钮内图片锚点应保留');
  assert.equal(result.images.length, 1);
});

// canvas 组图（#52，labuladong 算法图形：每容器多层叠放 2d canvas、懒渲染、无独立 URL）：
// 按父容器分组合成一张 PNG，以 bytesBase64 接入图片管线，锚点留在组图原位置；
// 全透明组（未滚入视口未渲染/空层）丢弃，不产生空白图片块
function canvasLayer(width, height, painted) {
  const node = element('canvas');
  node.width = width;
  node.height = height;
  node.getContext = () => ({
    getImageData: (x, y, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      if (painted) data[3] = 255; // 有一个非零 alpha 即视为已绘制
      return { data };
    },
  });
  return node;
}

test('canvas 组图：同容器多图层合成一张 PNG 候选，锚点留在组图原位置', async () => {
  const doc = {
    title: 'canvas 组图',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('div', [canvasLayer(1508, 596, false), canvasLayer(1508, 596, true), canvasLayer(1508, 596, false)]),
      element('p', [textNode('后续段落')]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.images.length, 1, '一组 canvas 合成一个图片候选');
  assert.equal(result.images[0].mimeType, 'image/png');
  assert.ok(result.images[0].bytesBase64, '合成结果应以 bytesBase64 接入图片管线');
  assert.equal(result.images[0].source, null, 'canvas 组图没有原站 URL');
  assert.equal(result.images[0].width, 1508);
  assert.equal(result.images[0].height, 596);
  const anchorAt = result.markdown.indexOf('[[FEISHU_CLIP_IMAGE:0]]');
  assert.ok(anchorAt > -1, '组图原位应留锚点');
  assert.ok(anchorAt > result.markdown.indexOf(LONG.slice(0, 12)) && anchorAt < result.markdown.indexOf('后续段落'), '锚点应在组图原位置（前后段落之间）');
});

test('canvas 组图：全透明组（未渲染）丢弃，不产生候选和锚点', async () => {
  const doc = {
    title: '未渲染 canvas',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('div', [canvasLayer(1508, 596, false), canvasLayer(1508, 596, false)]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.images.length, 0, '全透明组应丢弃');
  assert.ok(!result.markdown.includes('FEISHU_CLIP_IMAGE'), '丢弃的组不应留锚点');
});

test('canvas 组图：多个容器各自成组，候选与锚点按文档顺序排列', async () => {
  const doc = {
    title: '多组 canvas',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('div', [canvasLayer(100, 100, true), canvasLayer(100, 100, false)]),
      element('p', [textNode('中间段落')]),
      element('div', [canvasLayer(200, 80, true)]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.equal(result.images.length, 2, '每个容器各合成一张');
  assert.equal(result.images[0].width, 100);
  assert.equal(result.images[1].width, 200);
  const first = result.markdown.indexOf('[[FEISHU_CLIP_IMAGE:0]]');
  const second = result.markdown.indexOf('[[FEISHU_CLIP_IMAGE:1]]');
  assert.ok(first > -1 && second > first, '锚点应按文档顺序编号排列');
});

// markmap 大纲转写（#54）：labuladong 的思维导图是 markmap 组件——源 markdown 内嵌在
// Next.js RSC 流式 payload（内联 script，JSON 转义形态），客户端渲染成内联 svg.markmap-svg。
// svg 原本随垃圾清理整块丢失；现在按 DOM 顺序与 payload 里的源配对，转写为嵌套无序列表，
// 锚定在导图原位置（保文字层级，丢图形；不做 SVG 光栅化，已否决）
const MARKMAP_SOURCE = '---\nmarkmap:\n  pan: false\n  colorFreezeLevel: 2\n---\n\n# 最短路径问题\n\n## 单源最短路径\n\n### Dijkstra 算法\n\n- 由 BFS 算法扩展而来\n- 适用于非负权图\n\n### Bellman-Ford 算法\n\n- 可以处理负权边';

function markmapSvg() {
  const node = element('svg');
  node.setAttribute('class', 'markmap-svg markmap');
  return node;
}

// RSC payload 夹具：extractor 从 document.querySelectorAll('script') 读 script 的 textContent
function rscPayload(content) {
  return { textContent: JSON.stringify({ content }) }; // JSON 转义形态（\n 为字面两字符）
}

test('markmap 导图：转写为嵌套无序列表，锚定在导图原位置', async () => {
  const doc = {
    title: 'markmap 页面',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('div', [markmapSvg()]),
      element('p', [textNode('导图之后的段落')]),
    ]),
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'script' ? [rscPayload(MARKMAP_SOURCE)] : []),
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  // 转写规则：标题每深一级多一层缩进，标题下的 - 项再深一层；frontmatter 丢弃
  const outline = [
    '- 最短路径问题',
    '  - 单源最短路径',
    '    - Dijkstra 算法',
    '      - 由 BFS 算法扩展而来',
    '      - 适用于非负权图',
    '    - Bellman-Ford 算法',
    '      - 可以处理负权边',
  ];
  const lines = result.markdown.split('\n');
  const start = lines.findIndex((line) => line === '- 最短路径问题');
  assert.ok(start > -1, '应有导图大纲');
  assert.deepEqual(lines.slice(start, start + outline.length), outline);
  assert.ok(!result.markdown.includes('pan: false'), 'frontmatter 应丢弃');
  const before = lines.findIndex((line) => line.includes('足够长的正文内容'));
  const after = lines.findIndex((line) => line.includes('导图之后的段落'));
  assert.ok(start > before && start + outline.length <= after, '大纲应锚定在导图原位置（前后段落之间）');
});

test('一页多个 markmap 导图：按 DOM 顺序与 payload 顺序配对', async () => {
  const doc = {
    title: '多导图页面',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('div', [markmapSvg()]),
      element('p', [textNode('两个导图之间的段落')]),
      element('div', [markmapSvg()]),
    ]),
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'script' ? [rscPayload('---\nmarkmap:\n  pan: false\n---\n\n# 甲图\n\n- 甲要点'), rscPayload('---\nmarkmap:\n  pan: false\n---\n\n# 乙图\n\n- 乙要点')] : []),
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  const first = result.markdown.indexOf('- 甲图');
  const middle = result.markdown.indexOf('两个导图之间的段落');
  const second = result.markdown.indexOf('- 乙图');
  assert.ok(first > -1 && second > -1, '两个导图都应转写');
  assert.ok(first < middle && middle < second, '源应按出现顺序与导图配对');
  assert.ok(result.markdown.includes('  - 甲要点') && result.markdown.includes('  - 乙要点'));
});

test('markmap 源数量与导图数量不符：跳过转写，不产生空列表', async () => {
  const doc = {
    title: '配对失败',
    body: element('body', [
      element('p', [textNode(LONG)]),
      element('div', [markmapSvg()]),
      element('div', [markmapSvg()]),
    ]),
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'script' ? [rscPayload('---\nmarkmap:\n  pan: false\n---\n\n# 只有一个源')] : []), // 2 个导图 1 个源
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('- 只有一个源'), '配对不可靠时应整体跳过');
  assert.ok(!result.markdown.includes('markmap'), '不应残留导图内容');
});

test('markmap 找不到源：导图跳过且不残留 svg 内容', async () => {
  const doc = {
    title: '无源导图',
    body: element('body', [element('p', [textNode(LONG)]), element('div', [markmapSvg()])]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('- '), '无源导图不应产生空列表');
});

test('普通 svg（图标等）不触发 markmap 转写，既有清理行为不变', async () => {
  const icon = element('svg');
  icon.setAttribute('class', 'w-4 h-4');
  const doc = {
    title: '普通 svg',
    body: element('body', [element('p', [textNode(LONG), icon, textNode('结尾')])]),
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'script' ? [rscPayload('---\nmarkmap:\n  pan: false\n---\n\n# 不应被消费的源')] : []),
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('- 不应被消费的源'), '无 markmap 导图时源不得进入正文');
  assert.ok(result.markdown.includes('结尾'));
});

// 高亮块转写（#55）：labuladong 等站点的提示框（前置知识/一句话总结/注意事项）是 Tailwind
// 容器 div.bg-{color}-50（首子元素为图标 svg + 标题行），平铺渲染会丢掉视觉分组。
// 转写为 <callout> XML 岛（bridge 的 lark-cli markdown 导入解析 XML 标签，已实测可行）：
// background-color="light-{color}" border-color="{color}"，emoji 按色名固定映射，无匹配默认 💡。
// 容器内含 callout 不支持的子块（图片锚点/pre 代码块/表格/嵌套高亮块）时回退平铺渲染
function calloutBox(color, children) {
  const box = element('div', children);
  box.setAttribute('class', `bg-${color}-50 rounded-lg p-4`);
  return box;
}

function calloutTitleRow(title) {
  return element('div', [element('svg'), element('span', [textNode(title)])]); // 图标 svg + 标题文字
}

test('高亮块：bg-blue-50 容器转写为 callout，标题行保留为首个加粗段落，svg 图标清理', async () => {
  const doc = {
    title: '高亮块页面',
    body: element('body', [
      element('p', [textNode(LONG)]),
      calloutBox('blue', [calloutTitleRow('前置知识'), element('p', [textNode('需要先了解图的基本遍历算法')])]),
      element('p', [textNode('高亮块之后的段落')]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(result.markdown.includes('<callout emoji="📘" background-color="light-blue" border-color="blue">'), '应转写为 callout 且颜色映射正确');
  assert.ok(result.markdown.includes('<p><b>前置知识</b></p>'), '标题行应保留为 callout 内首个加粗段落');
  assert.ok(result.markdown.includes('<p>需要先了解图的基本遍历算法</p>'));
  assert.ok(result.markdown.includes('</callout>'));
  assert.ok(result.markdown.indexOf('<callout') > result.markdown.indexOf(LONG.slice(0, 12)), 'callout 应锚定在容器原位置');
  assert.ok(result.markdown.indexOf('</callout>') < result.markdown.indexOf('高亮块之后的段落'));
});

test('高亮块 emoji 颜色映射：purple→📌 yellow→⚠️ red→❗ green→✅ 未知色→💡', async () => {
  const cases = { purple: '📌', yellow: '⚠️', red: '❗', green: '✅', pink: '💡' };
  for (const [color, emoji] of Object.entries(cases)) {
    const doc = {
      title: `${color} 高亮块`,
      body: element('body', [
        element('p', [textNode(LONG)]),
        calloutBox(color, [calloutTitleRow('提示'), element('p', [textNode('内容')])]),
      ]),
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const result = await runExtractor(doc);
    assert.equal(result.error, undefined);
    assert.ok(result.markdown.includes(`<callout emoji="${emoji}" background-color="light-${color}" border-color="${color}">`), `${color} 应映射为 ${emoji}`);
  }
});

test('高亮块内含 pre 代码块：回退平铺渲染，不产生非法 callout', async () => {
  const doc = {
    title: '带代码块的高亮块',
    body: element('body', [
      element('p', [textNode(LONG)]),
      calloutBox('yellow', [calloutTitleRow('注意'), element('pre', [textNode('const x = 1;')])]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('<callout'), '含 pre 的高亮块应回退平铺');
  assert.ok(result.markdown.includes('```\nconst x = 1;\n```'), '代码块应照常渲染');
  assert.ok(result.markdown.includes('注意'), '标题文字不丢');
});

test('高亮块内含图片：回退平铺渲染，图片锚点保留', async () => {
  const doc = {
    title: '带图高亮块',
    body: element('body', [
      element('p', [textNode(LONG)]),
      calloutBox('green', [calloutTitleRow('总结'), element('p', [textNode('见下图'), img('https://example.test/in-callout.png')])]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('<callout'), '含图片锚点的高亮块应回退平铺');
  assert.ok(result.markdown.includes('[[FEISHU_CLIP_IMAGE:0]]'), '图片锚点应保留');
});

test('高亮块内含表格：回退平铺渲染', async () => {
  const table = element('table', [
    element('tr', [element('th', [textNode('列一')])]),
    element('tr', [element('td', [textNode('值一')])]),
  ]);
  const doc = {
    title: '带表格高亮块',
    body: element('body', [
      element('p', [textNode(LONG)]),
      calloutBox('red', [calloutTitleRow('对比'), table]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('<callout'), '含表格的高亮块应回退平铺');
  assert.ok(result.markdown.includes('| 列一 |'), '表格应照常渲染');
});

test('高亮块内文本按 XML 规则转义：& < > 不断句', async () => {
  const doc = {
    title: '特殊字符高亮块',
    body: element('body', [
      element('p', [textNode(LONG)]),
      calloutBox('blue', [calloutTitleRow('提示'), element('p', [textNode('a & b 对比：1 < 2 且 3 > 2')])]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(result.markdown.includes('<p>a &amp; b 对比：1 &lt; 2 且 3 &gt; 2</p>'), 'callout 内文本应 XML 转义且不断句');
});

test('高亮块内的行内格式与列表：转为 XML 标签', async () => {
  const doc = {
    title: '富内容高亮块',
    body: element('body', [
      element('p', [textNode(LONG)]),
      calloutBox('purple', [
        calloutTitleRow('一句话总结'),
        element('p', [element('strong', [textNode('Dijkstra')]), textNode(' 本质是带优先级的 BFS')]),
        element('ul', [element('li', [textNode('第一点')]), element('li', [textNode('第二点')])]),
      ]),
    ]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(result.markdown.includes('<p><b>Dijkstra</b> 本质是带优先级的 BFS</p>'), '行内加粗应转为 <b>');
  assert.ok(result.markdown.includes('<ul><li>第一点</li><li>第二点</li></ul>'), '列表应转为 <ul><li>');
});

test('无背景色类的普通 div：渲染行为不变，不包 callout', async () => {
  const plain = element('div', [element('p', [textNode('普通容器内容')])]);
  plain.setAttribute('class', 'prose max-w-none');
  const doc = {
    title: '普通 div',
    body: element('body', [element('p', [textNode(LONG)]), plain]),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const result = await runExtractor(doc);
  assert.equal(result.error, undefined);
  assert.ok(!result.markdown.includes('<callout'));
  assert.ok(result.markdown.includes('普通容器内容'));
});
