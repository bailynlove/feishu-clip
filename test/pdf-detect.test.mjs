// pdf-detect.js 弹窗探测回归（#65）：与 extractor.js 的 detectMainPdf 同一份规则，
// 外加一次 HEAD 尽力取 content-length。经典脚本（非模块），与生产注入同一条入口跑 vm。
// 注意：vm 产物的原型与测试侧不同，不能 deepEqual，逐字段断言。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const detectCode = await readFile(new URL('../src/extension/pdf-detect.js', import.meta.url), 'utf8');

function runDetect({ pageUrl, citation = null, head = null } = {}) {
  const context = vm.createContext({
    document: {
      querySelector: (selector) => (selector === 'meta[name="citation_pdf_url"]' && citation !== null
        ? { getAttribute: (name) => (name === 'content' ? citation : null) }
        : null),
    },
    location: new URL(pageUrl),
    URL,
    fetch: async (url, options) => {
      assert.equal(options.method, 'HEAD', '探测只发 HEAD 请求');
      if (head?.throw) throw new Error(head.throw);
      return {
        ok: head?.ok ?? true,
        headers: { get: (name) => (name.toLowerCase() === 'content-length' ? (head?.contentLength ?? null) : null) },
      };
    },
  });
  return vm.runInContext(detectCode, context);
}

test('arXiv abs 页识别主 PDF，HEAD 拿到 content-length 时带出 sizeBytes', async () => {
  const result = await runDetect({ pageUrl: 'https://arxiv.org/abs/2401.00001', head: { ok: true, contentLength: '524288' } });
  assert.equal(result.pdf.url, 'https://arxiv.org/pdf/2401.00001');
  assert.equal(result.pdf.name, '2401.00001.pdf');
  assert.equal(result.pdf.sizeBytes, 524288);
});

test('HEAD 失败（CORS/服务器不支持）：sizeBytes 为 null，探测结果仍可用', async () => {
  const result = await runDetect({ pageUrl: 'https://arxiv.org/abs/1706.03762', head: { throw: 'CORS' } });
  assert.equal(result.pdf.url, 'https://arxiv.org/pdf/1706.03762');
  assert.equal(result.pdf.sizeBytes, null);
});

test('HEAD 响应不 ok 或 content-length 非法：sizeBytes 为 null', async () => {
  for (const head of [{ ok: false, contentLength: '100' }, { ok: true, contentLength: null }, { ok: true, contentLength: 'abc' }]) {
    const result = await runDetect({ pageUrl: 'https://arxiv.org/abs/1706.03762', head });
    assert.equal(result.pdf.url, 'https://arxiv.org/pdf/1706.03762');
    assert.equal(result.pdf.sizeBytes, null, JSON.stringify(head));
  }
});

test('citation_pdf_url meta 命中：相对路径按页面 resolve，名字取 URL 末段', async () => {
  const result = await runDetect({ pageUrl: 'https://journal.example/articles/42', citation: '/papers/v2.pdf', head: { ok: true, contentLength: '1024' } });
  assert.equal(result.pdf.url, 'https://journal.example/papers/v2.pdf');
  assert.equal(result.pdf.name, 'v2.pdf');
  assert.equal(result.pdf.sizeBytes, 1024);
});

test('未识别（无站点规则无 meta）返回 pdf:null；非 http(s) meta 不识别', async () => {
  for (const input of [
    { pageUrl: 'https://blog.example/post' },
    { pageUrl: 'https://arxiv.org/list/cs.AI/recent' },
    { pageUrl: 'https://blog.example/post', citation: 'ftp://x/y.pdf' },
  ]) {
    const result = await runDetect(input);
    assert.equal(result.pdf, null, JSON.stringify(input));
  }
});

test('页面异常（location 等不可用）也安全返回 pdf:null', async () => {
  const context = vm.createContext({ document: null, location: null, URL, fetch: async () => { throw new Error('nope'); } });
  const result = await vm.runInContext(detectCode, context);
  assert.equal(result.pdf, null);
});
