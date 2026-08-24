import assert from 'node:assert/strict';
import test from 'node:test';
import { ClipExecutor, prepareMarkdown } from '../src/bridge/executor.mjs';

test('snapshot markers become traceable image anchors and unsafe sources are plain text', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [
      { label: 'public', source: 'https://cdn.example.com/a.png' },
      { label: 'blob', source: 'blob:https://example.com/id', bytesBase64: 'AA==' },
    ],
  }, 'attempt-1');
  assert.match(prepared.markdown, /图片：public（\[原图链接\]\(https:\/\/cdn\.example\.com\/a\.png\)）/);
  assert.match(prepared.markdown, /图片：blob/);
  assert.doesNotMatch(prepared.markdown, /blob:https/);
  assert.doesNotMatch(prepared.markdown, /FEISHU_CLIP_IMAGE/);
  assert.match(prepared.markdown, /剪藏尝试：attempt-1/);
});

test('includeImages keeps raw anchors for media-insert to locate', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'public', source: 'https://cdn.example.com/a.png' }],
  }, 'attempt-1', { includeImages: true });
  assert.match(prepared.markdown, /\[\[FEISHU_CLIP_IMAGE:0\]\]/);
  assert.doesNotMatch(prepared.markdown, /原图链接/);
});

// 图片阶段集成测试：脚本化假 lark 模拟 CLI 应答，验证锚点在表格单元格内时
// 走原生 API 把图片插进单元格（而不是 media-insert 插到表格外）。
const PNG_BYTES = (() => {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(64, 16);
  buffer.writeUInt32BE(64, 20);
  return buffer.toString('base64');
})();

function fakeStore(job) {
  let drained = false;
  let onSettled;
  const settled = new Promise((resolve) => { onSettled = resolve; });
  const store = {
    completed: null,
    settled,
    async list() { return drained ? [] : [job]; },
    async claim() {},
    async beginCreate() {},
    async recordDocument() {},
    async complete(_id, _worker, result) { store.completed = result; drained = true; onSettled(); },
    async get() { return { status: 'succeeded' }; },
    async fail(_id, _worker, result) { store.failed = result; drained = true; onSettled(); },
  };
  return store;
}

function fakeJob() {
  return {
    attemptId: 'attempt-cell',
    document: null,
    includeImages: true,
    destination: { kind: 'node', nodeToken: 'node-1' },
    snapshot: {
      title: 'T', sourceUrl: 'https://example.com', capturedAt: '2026-08-24T00:00:00.000Z',
      markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
      images: [{ label: 'photo', bytesBase64: PNG_BYTES }],
    },
  };
}

function fakeLark({ anchorParent }) {
  const calls = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      const [head, sub] = args;
      if (head === 'docs' && sub === '+create') return { ok: true, data: { document: { document_id: 'doc1', url: 'https://doc1' } } };
      if (head === 'docs' && sub === '+fetch') return { ok: true, data: { document: { content: '<p id="p0">[[FEISHU_CLIP_IMAGE:0]]</p>' } } };
      if (head === 'docs' && sub === '+media-upload') return { ok: true, data: { file_token: 'tok1' } };
      if (head === 'docs' && (sub === '+update' || sub === '+media-insert')) return { ok: true, data: {} };
      if (head === 'api') {
        const [, method, apiPath] = args;
        if (method === 'GET' && apiPath.endsWith('/blocks/p0')) return { ok: true, data: { block: { block_id: 'p0', parent_id: anchorParent.block_id, block_type: 2 } } };
        if (method === 'GET' && apiPath.endsWith(`/blocks/${anchorParent.block_id}`)) return { ok: true, data: { block: anchorParent } };
        if (method === 'GET' && apiPath.endsWith('/children')) return { ok: true, data: { items: [{ block_id: 'p0' }] } };
        if (method === 'POST') return { ok: true, data: { children: [{ block_id: 'i0' }] } };
        return { ok: true, data: {} };
      }
      throw new Error(`unexpected lark call: ${args.join(' ')}`);
    },
  };
}

test('image anchored inside a table cell is inserted into the cell via raw API, not media-insert', async () => {
  const store = fakeStore(fakeJob());
  const lark = fakeLark({ anchorParent: { block_id: 'c0', parent_id: 't0', block_type: 32 } });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed, { warnings: [] });
  const cellInsert = lark.calls.find((args) => args[0] === 'api' && args[1] === 'POST' && args[2].includes('/blocks/c0/children'));
  assert.ok(cellInsert, '应在单元格 c0 内创建图片块');
  assert.ok(cellInsert.some((arg) => String(arg).includes('"block_type":27')), '创建的是空图片块');
  assert.ok(!lark.calls.some((args) => args[1] === '+media-insert'), '单元格场景不应走 media-insert');
  assert.ok(lark.calls.some((args) => args[1] === 'PATCH' && JSON.stringify(args).includes('replace_image')));
});

test('image anchored outside a table falls back to media-insert and removes the anchor', async () => {
  const store = fakeStore(fakeJob());
  const lark = fakeLark({ anchorParent: { block_id: 'doc1', parent_id: 'doc1', block_type: 1 } });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed, { warnings: [] });
  assert.ok(lark.calls.some((args) => args[1] === '+media-insert'), '非单元格场景应走 media-insert');
  const clear = lark.calls.find((args) => args[1] === '+update' && args.includes('str_replace'));
  assert.ok(clear && clear.includes(''), '成功后应清空锚点');
  assert.ok(!lark.calls.some((args) => args[0] === 'api' && args[1] === 'POST'), '非单元格场景不应建图片块');
});
