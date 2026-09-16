// arXiv abs 页排版对齐（#69）：fixture（test/fixtures/arxiv-abs.html，结构照抄真实
// https://arxiv.org/abs/2608.26263）+ linkedom 解析 + vm 跑真实 extractor.js。
// 目标产出对齐 Obsidian web clipper 样例：## 分类面包屑、## Title:、作者链接、
// > Abstract: 引用块、Comments/Subjects/Cite as 表格、## Submission history 版本列表；
// 零「悬浮内容」标记，hidden 提示块/role=tooltip/右侧 extra-services 栏目噪音不入正文。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const extractorCode = await readFile(new URL('../src/extension/extractor.js', import.meta.url), 'utf8');
const fixtureHtml = await readFile(new URL('./fixtures/arxiv-abs.html', import.meta.url), 'utf8');

function runExtractor(html, locationUrl) {
  const { document } = parseHTML(html);
  const context = vm.createContext({
    document,
    location: new URL(locationUrl),
    URL,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    fetch: async () => { throw new Error('no network in test'); },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    console,
  });
  return vm.runInContext(extractorCode, context);
}

const result = await runExtractor(fixtureHtml, 'https://arxiv.org/abs/2608.26263');
const { markdown } = result;

test('arXiv abs 页：提取成功且零「悬浮内容」标记', () => {
  assert.equal(result.error, undefined);
  assert.ok(!markdown.includes('悬浮内容'), '不得产生悬浮标记或注释');
});

test('arXiv abs 页：分类面包屑与论文标题渲染为 ##（文档标题才是 h1 语义）', () => {
  assert.ok(markdown.includes('## Computer Science > Artificial Intelligence'));
  assert.ok(markdown.includes('## Title:SKILL.state: Scalable Long-Horizon Agent Skills'));
  assert.ok(!/(^|\n)# /.test(markdown), '正文不应残留 h1 级标题');
});

test('arXiv abs 页：Authors 作者链接保留', () => {
  assert.ok(markdown.includes('[Sanket Badhe](https://arxiv.org/search/cs?searchtype=author&query=Badhe,+S)'));
  assert.ok(markdown.includes('[Priyanka Tiwari](https://arxiv.org/search/cs?searchtype=author&query=Tiwari,+P)'));
  assert.ok(markdown.includes('[Jonghyun Chung](https://arxiv.org/search/cs?searchtype=author&query=Chung,+J)'));
});

test('arXiv abs 页：摘要渲染为 > Abstract: 引用块', () => {
  assert.ok(markdown.includes('> Abstract:Large Language Models'), '摘要应为引用块');
});

test('arXiv abs 页：Comments/Subjects/Cite as 渲染为表格', () => {
  assert.ok(markdown.includes('| Comments: | accepted at EMNLP |'));
  assert.ok(markdown.includes('| Subjects: | Artificial Intelligence (cs.AI); Multiagent Systems (cs.MA) |'));
  assert.ok(markdown.includes('| Cite as: | arXiv:2608.26263 [cs.AI] |'));
});

test('arXiv abs 页：Submission history 版本列表（v1/v2/v3 链接与日期）', () => {
  assert.ok(markdown.includes('## Submission history'));
  // render 会转义链接文字里的方括号，[v1] → [\[v1\]]（markdown 合法，导入后仍显示 [v1]）
  assert.ok(markdown.includes('[\\[v1\\]](https://arxiv.org/abs/2608.26263v1)'));
  assert.ok(markdown.includes('Wed, 26 Aug 2026 18:00:06 UTC (253 KB)'));
  assert.ok(markdown.includes('[\\[v2\\]](https://arxiv.org/abs/2608.26263v2)'));
  assert.ok(markdown.includes('Fri, 28 Aug 2026 03:02:32 UTC (145 KB)'));
  assert.ok(markdown.includes('[v3]'), '当前版本 v3 无链接但应保留');
  assert.ok(markdown.includes('Wed, 2 Sep 2026 02:32:58 UTC (251 KB)'));
});

test('arXiv abs 页：hidden 提示块与 role=tooltip 等隐藏元素噪音不入正文', () => {
  assert.ok(!markdown.includes('View a PDF of the paper titled'), 'hidden 下载提示应剔除');
  assert.ok(!markdown.includes('BibTeX formatted citation'), 'hidden BibTeX 弹窗应剔除');
  assert.ok(!markdown.includes('arXiv-issued DOI via DataCite'), 'role=tooltip 悬浮说明应剔除');
});

test('arXiv abs 页：右侧 extra-services 栏目（下载按钮/浏览上下文/引用服务）不入正文', () => {
  assert.ok(!markdown.includes('Access Paper'), 'extra-services 应排除在正文根外');
  assert.ok(!markdown.includes('Current browse context'));
  assert.ok(!markdown.includes('Google Scholar'));
});

test('arXiv abs 页：正文提取不再维护 PDF 站点规则', () => {
  assert.equal(result.pdf, undefined);
});
