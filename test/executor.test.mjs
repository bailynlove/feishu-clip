import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClipExecutor, prepareMarkdown } from '../src/bridge/executor.mjs';
import { AI_FILE_MAX_BYTES } from '../src/bridge/ai-digest.mjs';
import { PdfChunkStaging } from '../src/bridge/pdf-chunks.mjs';

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

test('imageMode preview：有浏览器字节的图片保留锚点供上传管线定位', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'protected', source: 'https://example.com/a.png', bytesBase64: 'AA==' }],
  }, 'attempt-1', { imageMode: 'preview' });
  assert.match(prepared.markdown, /\[\[FEISHU_CLIP_IMAGE:0\]\]/);
  assert.doesNotMatch(prepared.markdown, /原图链接/);
});

// 图片管线（优先级：预览块 → 下载上传 → 纯链接）：无字节的公开图片保留锚点，
// 由 bridge 图片阶段建 iframe 预览块（原图 URL 直出）；有字节的同样保留锚点
test('imageMode preview：无字节的公开图片保留锚点，由 bridge 建预览块', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [
      { label: 'pub[lic]', source: 'https://cdn.example.com/a.png' },
      { label: 'protected', source: 'https://example.com/b.png', bytesBase64: 'AA==' },
    ],
  }, 'attempt-1', { imageMode: 'preview' });
  assert.match(prepared.markdown, /\[\[FEISHU_CLIP_IMAGE:0\]\]/, '公开图片保留锚点');
  assert.match(prepared.markdown, /\[\[FEISHU_CLIP_IMAGE:1\]\]/, '有字节的图片保留锚点');
  assert.doesNotMatch(prepared.markdown, /!\[/, '不再内联为 Markdown 图片语法');
});

test('imageMode preview：无字节且 URL 不安全的图片直接降级为文本，不进上传管线', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'blob图', source: 'blob:https://example.com/id' }],
  }, 'attempt-1', { imageMode: 'preview' });
  assert.match(prepared.markdown, /图片：blob图/);
  assert.doesNotMatch(prepared.markdown, /blob:https/);
  assert.doesNotMatch(prepared.markdown, /FEISHU_CLIP_IMAGE/);
  assert.notEqual(prepared.images[0].inline, true, 'URL 不安全不能内联');
});

// 图片写入模式（#53）：off 等价于旧 includeImages=false（锚点落成含原图链接的可读文本）；
// download 与 preview 一样保留锚点，差别在图片阶段是否跳过预览块 pass
test('imageMode off：锚点直接落成含原图链接的可读文本（同旧 includeImages:false）', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'public', source: 'https://cdn.example.com/a.png' }],
  }, 'attempt-1', { imageMode: 'off' });
  assert.match(prepared.markdown, /图片：public（\[原图链接\]\(https:\/\/cdn\.example\.com\/a\.png\)）/);
  assert.doesNotMatch(prepared.markdown, /FEISHU_CLIP_IMAGE/);
});

test('imageMode download：公开图片同样保留锚点，由 bridge 图片阶段走下载管线', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'pub', source: 'https://cdn.example.com/a.png' }],
  }, 'attempt-1', { imageMode: 'download' });
  assert.match(prepared.markdown, /\[\[FEISHU_CLIP_IMAGE:0\]\]/, 'download 模式保留锚点');
});

// 图片阶段集成测试：脚本化假 lark 模拟 CLI 应答，验证新管线——
// 一次 blocks 全量拉取定位所有锚点，然后逐图走原生块操作（建空图片块 → 上传 → 绑定 → 删锚点），
// 不再出现 keyword 探测和 media-insert。
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
    failed: null,
    digestRecorded: null,
    settled,
    async list() { return drained ? [] : [job]; },
    async claim() {},
    async heartbeat() {},
    async beginCreate() {},
    async recordDocument() {},
    async recordDigest(_id, _worker, digestText) { store.digestRecorded = digestText; },
    async complete(_id, _worker, result) { store.completed = result; drained = true; onSettled(); },
    async get() { return { status: 'succeeded' }; },
    async fail(_id, _worker, result) { store.failed = result; drained = true; onSettled(); },
  };
  return store;
}

test('PDF 失败策略 abort：PDF 失败时在建档前终止剪藏', async () => {
  const job = { ...fakeJob({ markdown: '正文', images: [] }), pdfFailurePolicy: 'abort' };
  const store = fakeStore(job);
  let workerId;
  store.claim = async (_attemptId, worker) => { workerId = worker; };
  store.get = async (_attemptId, kind) => {
    if (kind === 'clip') return { ...job, status: 'running', workerId };
    if (kind === 'pdf') return { kind: 'pdf', status: 'failed', error: 'PDF_HTTP_202' };
    return [{ kind: 'clip', status: 'running' }, { kind: 'pdf', status: 'failed', error: 'PDF_HTTP_202' }];
  };
  const lark = fakeLark({ items: [] });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(lark.calls.length, 0, 'PDF 失败后不得创建文档');
  assert.match(store.failed?.error, /PDF 保存失败.*PDF_HTTP_202/);
});

test('PDF 失败策略 abort：等待 PDF 成功后才继续建档', async () => {
  const job = { ...fakeJob({ markdown: '正文', images: [] }), pdfFailurePolicy: 'abort' };
  const store = fakeStore(job);
  let reads = 0;
  store.get = async (_attemptId, kind) => {
    if (kind === 'clip') return { ...job, status: 'running' };
    if (kind === 'pdf') return { kind: 'pdf', status: 'succeeded' };
    reads += 1;
    return [{ kind: 'clip', status: 'running' }, { kind: 'pdf', status: reads === 1 ? 'running' : 'succeeded' }];
  };
  const lark = fakeLark({ items: [] });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, sleep: async () => {} }).kick();
  await store.settled;
  assert.ok(reads >= 2, 'PDF 未完成时应继续等待');
  assert.ok(lark.calls.some((args) => args[0] === 'docs' && args[1] === '+create'), 'PDF 成功后继续建档');
  assert.ok(store.completed, '剪藏最终成功');
});

function fakeJob({ markdown, images }) {
  return {
    attemptId: 'attempt-pipe',
    document: null,
    imageMode: 'preview',
    destination: { kind: 'node', nodeToken: 'node-1' },
    snapshot: {
      title: 'T', sourceUrl: 'https://example.com', capturedAt: '2026-08-24T00:00:00.000Z',
      markdown,
      images,
    },
  };
}

// 构造 docx 块列表：text 型块（block_type 2）带正文，容器块带 children
function textBlock(id, parent, text) {
  return { block_id: id, parent_id: parent, block_type: 2, text: { elements: [{ text_run: { content: text } }] } };
}
function containerBlock(id, parent, type, children) {
  return { block_id: id, parent_id: parent, block_type: type, children };
}

// failOn(args) 返回 true 时该次调用抛错，用于模拟单图失败
function fakeLark({ items, failOn } = {}) {
  const calls = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      if (failOn?.(args)) throw new Error('upload boom');
      const [head, sub] = args;
      if (head === 'docs' && sub === '+create') return { ok: true, data: { document: { document_id: 'doc1', url: 'https://doc1' } } };
      if (head === 'docs' && sub === '+media-upload') return { ok: true, data: { file_token: 'tok1' } };
      if (head === 'docs' && (sub === '+update' || sub === '+media-insert')) return { ok: true, data: {} };
      if (head === 'wiki' && sub === '+node-delete') return { ok: true, data: {} };
      if (head === 'api') {
        const [, method, apiPath] = args;
        if (method === 'GET' && apiPath.endsWith('/blocks')) return { ok: true, data: { items, has_more: false } };
        if (method === 'POST') return { ok: true, data: { children: [{ block_id: 'img-new' }] } };
        return { ok: true, data: {} };
      }
      throw new Error(`unexpected lark call: ${args.join(' ')}`);
    },
  };
}

const apiCalls = (calls, method, suffix) => calls.filter((args) => args[0] === 'api' && args[1] === method && args[2].includes(suffix));
const deleteBody = (args) => JSON.parse(args[args.indexOf('--data') + 1]);

// 图片尺寸回归（langgraph 文档全部 100x100）：建图片块必须带原始宽高，
// 空块 + replace_image 不会重算尺寸。尺寸来源优先级：snapshot 合法宽高 → 字节解析 → 空对象
function singleImageJob(images) {
  return fakeJob({ markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]', images });
}
function singleAnchorSetup(job) {
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items });
  return { store, lark };
}
const createdImage = (calls) => {
  const [insert] = apiCalls(calls, 'POST', '/children');
  return JSON.parse(insert[insert.indexOf('--data') + 1]).children[0].image;
};
// replace_image 会把宽高重置回 100x100（真实文档验证过），尺寸必须随 token 再传一遍
const replacedImage = (calls) => {
  const [patch] = apiCalls(calls, 'PATCH', '/blocks/');
  return JSON.parse(patch[patch.indexOf('--data') + 1]).replace_image;
};

test('image block carries snapshot dimensions when they are valid integers', async () => {
  const job = singleImageJob([{ label: 'a', bytesBase64: PNG_BYTES, width: 4572, height: 2047 }]);
  const { store, lark } = singleAnchorSetup(job);
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.deepEqual(createdImage(lark.calls), { width: 4572, height: 2047 }, 'snapshot 的合法宽高优先');
  assert.deepEqual(replacedImage(lark.calls), { token: 'tok1', width: 4572, height: 2047 }, '绑定 token 时尺寸要再传一遍');
});

test('invalid snapshot dimensions fall back to parsing the image bytes', async () => {
  for (const bad of [{ width: 0, height: 2047 }, { width: 4572, height: 1.5 }, { width: 100001, height: 2047 }, {}]) {
    const job = singleImageJob([{ label: 'a', bytesBase64: PNG_BYTES, ...bad }]);
    const { store, lark } = singleAnchorSetup(job);
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
    await store.settled;
    assert.deepEqual(createdImage(lark.calls), { width: 64, height: 64 }, `坏值 ${JSON.stringify(bad)} 应回退到字节解析（PNG_BYTES 是 64x64）`);
    assert.deepEqual(replacedImage(lark.calls), { token: 'tok1', width: 64, height: 64 });
  }
});

test('image block stays empty when neither snapshot nor bytes yield dimensions', async () => {
  // 只有 PNG 魔数没有 IHDR：能通过字节校验，但解析不出尺寸
  const headerOnly = Buffer.alloc(8);
  headerOnly.writeUInt32BE(0x89504e47, 0);
  headerOnly.writeUInt32BE(0x0d0a1a0a, 4);
  const job = singleImageJob([{ label: 'a', bytesBase64: headerOnly.toString('base64') }]);
  const { store, lark } = singleAnchorSetup(job);
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.deepEqual(createdImage(lark.calls), {}, '两个来源都没有尺寸时维持空 image 对象');
  assert.deepEqual(replacedImage(lark.calls), { token: 'tok1' }, '无尺寸时 replace_image 也不带宽高');
});

test('anchors are located by a single blocks fetch; no keyword probe and no media-insert', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }, { label: 'b', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['h0', 'p0', 'x0', 'p1']),
    textBlock('h0', 'doc1', 'T'),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
    textBlock('x0', 'doc1', '中间'),
    textBlock('p1', 'doc1', '[[FEISHU_CLIP_IMAGE:1]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(apiCalls(lark.calls, 'GET', '/blocks').length, 1, '只应有一次 blocks 全量拉取');
  assert.ok(!lark.calls.some((args) => args[1] === '+fetch'), '不应再做 keyword 探测');
  assert.ok(!lark.calls.some((args) => args[1] === '+media-insert'), '不应再走 media-insert');
  assert.equal(apiCalls(lark.calls, 'POST', '/children').length, 2, '每张图建一个空图片块');
  assert.equal(apiCalls(lark.calls, 'PATCH', '/blocks/').length, 2, '每张图绑定一次 file_token');
  // lark-cli 只接受 cwd 内的相对 --file 路径（真实 CLI 验证过的坑）
  const uploads = lark.calls.filter((args) => args[1] === '+media-upload');
  assert.equal(uploads.length, 2);
  for (const upload of uploads) {
    assert.equal(path.isAbsolute(upload[upload.indexOf('--file') + 1]), false, 'media-upload 的 --file 必须是相对路径');
  }
});

test('images in the same parent are inserted in reverse index order so indices stay valid', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }, { label: 'b', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['h0', 'p0', 'x0', 'p1']),
    textBlock('h0', 'doc1', 'T'),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
    textBlock('x0', 'doc1', '中间'),
    textBlock('p1', 'doc1', '[[FEISHU_CLIP_IMAGE:1]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  const inserts = apiCalls(lark.calls, 'POST', '/blocks/doc1/children');
  assert.equal(inserts.length, 2);
  assert.match(inserts[0].join(' '), /"index":3/, '先处理下标大的锚点 p1');
  assert.match(inserts[1].join(' '), /"index":1/, '再处理下标小的锚点 p0');
  const deletes = apiCalls(lark.calls, 'DELETE', 'batch_delete');
  assert.equal(deletes.length, 2);
  // 分阶段插入（#46）下同父块所有图片块先就位，锚点被每个「下标 ≤ 它」的同父锚点顶右一位：
  // p1 原始下标 3 → 当前 3+2=5；p0 原始下标 1 → 当前 1+1=2
  assert.deepEqual(deleteBody(deletes[0]), { start_index: 5, end_index: 6 });
  assert.deepEqual(deleteBody(deletes[1]), { start_index: 2, end_index: 3 });
});

test('anchor inside a table cell inserts the image block into the cell parent', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['t0']),
    containerBlock('t0', 'doc1', 31, ['c0']),
    containerBlock('c0', 't0', 32, ['p0']),
    textBlock('p0', 'c0', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  const cellInsert = apiCalls(lark.calls, 'POST', '/blocks/c0/children');
  assert.equal(cellInsert.length, 1, '应在单元格 c0 内创建图片块');
  assert.match(cellInsert[0].join(' '), /"block_type":27/);
  assert.match(cellInsert[0].join(' '), /"index":0/);
  const deletes = apiCalls(lark.calls, 'DELETE', '/blocks/c0/children/batch_delete');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deleteBody(deletes[0]), { start_index: 1, end_index: 2 });
  assert.ok(!lark.calls.some((args) => args[1] === '+media-insert'));
});

test('a failed image keeps a warning, cleans up the empty block and falls back to str_replace', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [
      { label: 'a', bytesBase64: PNG_BYTES },
      // 无公开 URL（不进预览块管线），有字节 → 走下载上传管线
      { label: 'b', bytesBase64: PNG_BYTES },
    ],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0', 'p1']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
    textBlock('p1', 'doc1', '[[FEISHU_CLIP_IMAGE:1]]'),
  ];
  // 第二张图（image-2.png）上传失败
  const lark = fakeLark({ items, failOn: (args) => args[1] === '+media-upload' && args.some((arg) => String(arg).endsWith('image-2.png')) });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(store.completed.warnings.length, 1);
  assert.match(store.completed.warnings[0], /图片 2：upload boom/);
  // 失败图片留下的空图片块要清掉：p1 原始下标 1，被两个「下标 ≤ 它」的同父锚点顶右，
  // 空块当前下标 = 1+2-1 = 2，删除 [2,3)
  const deletes = apiCalls(lark.calls, 'DELETE', 'batch_delete').map(deleteBody);
  assert.ok(deletes.some((body) => body.start_index === 2 && body.end_index === 3), '应清掉失败图片的空块');
  // 失败的锚点最后用 str_replace 换成可读文案
  const fallback = lark.calls.find((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IMAGE:1]]'));
  assert.ok(fallback, '失败锚点应走 str_replace 回退');
  // 成功的图片不受影响
  assert.equal(apiCalls(lark.calls, 'PATCH', '/blocks/').length, 1);
});

test('executor records a timeline with stages, per-image entries and cli calls', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  const { timeline, totalMs } = store.completed;
  assert.ok(Array.isArray(timeline), 'complete 应收到 timeline');
  assert.equal(typeof totalMs, 'number');
  const createStage = timeline.find((entry) => entry.kind === 'stage' && entry.name === 'create_document');
  const imagesStage = timeline.find((entry) => entry.kind === 'stage' && entry.name === 'images');
  assert.ok(createStage && typeof createStage.ms === 'number');
  assert.ok(imagesStage && typeof imagesStage.ms === 'number');
  const imageEntry = timeline.find((entry) => entry.kind === 'image' && entry.name === 'image-1');
  assert.ok(imageEntry && typeof imageEntry.ms === 'number');
  const cliNames = timeline.filter((entry) => entry.kind === 'cli').map((entry) => entry.name);
  for (const expected of ['docs +create', 'api GET', 'api POST', 'docs +media-upload', 'api PATCH', 'api DELETE']) {
    assert.ok(cliNames.includes(expected), `timeline 缺少 cli 记录：${expected}`);
  }
  // 时间线按发生顺序：create_document 阶段条目排在该阶段最后一次 cli 调用之后
  const lastCreateCli = timeline.map((entry, index) => [entry, index]).filter(([entry]) => entry.kind === 'cli' && entry.name === 'docs +create').at(-1)[1];
  assert.ok(timeline.indexOf(createStage) > lastCreateCli);
});

test('a failed job still persists the timeline collected so far', async () => {
  const job = fakeJob({ markdown: '# T', images: [] });
  job.imageMode = 'off';
  const store = fakeStore(job);
  const lark = { async run() { throw new Error('create boom'); } };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.ok(store.failed, '建文档失败应走 fail');
  assert.equal(store.failed.stage, 'create_document');
  assert.ok(Array.isArray(store.failed.timeline));
  assert.ok(store.failed.timeline.some((entry) => entry.kind === 'cli' && entry.name === 'docs +create' && entry.detail === 'create boom'));
  assert.equal(typeof store.failed.totalMs, 'number');
});

test('anchor embedded in list-item text falls back to media-insert and never batch-deletes the item', async () => {
  const job = fakeJob({
    markdown: '# T\n\n- 要点 [[FEISHU_CLIP_IMAGE:0]] 后缀',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  // 锚点混在列表项（block_type 12）文本中间：不是独立块，不能原生插入+删除
  const items = [
    containerBlock('doc1', '', 1, ['b0']),
    { block_id: 'b0', parent_id: 'doc1', block_type: 12, bullet: { elements: [{ text_run: { content: '要点 [[FEISHU_CLIP_IMAGE:0]] 后缀' } }] } },
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  const insert = lark.calls.find((args) => args[1] === '+media-insert');
  assert.ok(insert, '内嵌锚点应回退 media-insert 顶层插入');
  assert.ok(insert.includes('[[FEISHU_CLIP_IMAGE:0]]'), 'media-insert 按锚点文本定位');
  assert.equal(path.isAbsolute(insert[insert.indexOf('--file') + 1]), false, 'media-insert 的 --file 必须是 cwd 内相对路径');
  assert.ok(!apiCalls(lark.calls, 'DELETE', 'batch_delete').length, '不得 batch_delete 误删有内容的列表项');
  assert.ok(!apiCalls(lark.calls, 'POST', '/children').length, '内嵌锚点不建原生图片块');
  const clear = lark.calls.find((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IMAGE:0]]'));
  assert.ok(clear, 'media-insert 成功后应抹掉锚点');
  assert.ok(store.completed.timeline.some((entry) => entry.kind === 'image' && entry.name === 'image-1'), 'fallback 路径也计 image 时间线条目');
});

// 分阶段写入（#46）：块操作（建块/绑定/删锚点）推进文档版本必须串行，
// 媒体上传不动文档版本，集中并行——可观察契约是调用顺序：全部建块 → 全部上传 → 全部绑定
test('上传管线分阶段：全部建块完成后才上传，全部上传完成后才绑定', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }, { label: 'b', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0', 'x0', 'p1']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
    textBlock('x0', 'doc1', '中间'),
    textBlock('p1', 'doc1', '[[FEISHU_CLIP_IMAGE:1]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  const phases = lark.calls.map((args) => {
    if (args[0] === 'api' && args[1] === 'POST' && args[2].includes('/children')) return 'create-block';
    if (args[1] === '+media-upload') return 'upload';
    if (args[0] === 'api' && args[1] === 'PATCH') return 'bind';
    if (args[0] === 'api' && args[1] === 'DELETE') return 'delete-anchor';
    return null;
  }).filter(Boolean);
  assert.deepEqual(phases, ['create-block', 'create-block', 'upload', 'upload', 'bind', 'delete-anchor', 'bind', 'delete-anchor']);
});

// 建块失败的下标换算（code-review 发现的边界）：低位锚点建块失败时没有块顶位，
// 高位锚点的删除下标只能按「建块成功数」右移，否则会误删正文块
test('同父块内低位锚点建块失败：高位锚点下标按实际建块成功数换算', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }, { label: 'b', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0', 'x0', 'p1']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
    textBlock('x0', 'doc1', '中间'),
    textBlock('p1', 'doc1', '[[FEISHU_CLIP_IMAGE:1]]'),
  ];
  // 低位锚点 p0（父块内下标 0）建块失败
  const lark = fakeLark({ items, failOn: (args) => args[0] === 'api' && args[1] === 'POST' && args.some((arg) => String(arg).includes('"index":0')) });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(store.completed.warnings.length, 1);
  assert.match(store.completed.warnings[0], /图片 1/);
  // p1 原始下标 2，只有自己的图片块顶位（p0 没建成）→ 当前下标 2+1=3，删 [3,4)
  const deletes = apiCalls(lark.calls, 'DELETE', 'batch_delete').map(deleteBody);
  assert.deepEqual(deletes, [{ start_index: 3, end_index: 4 }], '高位锚点只能按建块成功的数量右移');
  // 建块失败的锚点仍在文档里，走 str_replace 回退
  assert.ok(lark.calls.some((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IMAGE:0]]')));
});

// 频控退避（#46 AC）：429/99991400 带抖动重试，其他错误不重试
test('媒体上传遇到 99991400 频控时退避重试并最终成功', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items });
  let uploads = 0;
  const baseRun = lark.run.bind(lark);
  lark.run = async (args, options) => {
    if (args[1] === '+media-upload') {
      uploads += 1;
      if (uploads === 1) throw Object.assign(new Error('rate limited'), { code: '99991400' });
    }
    return baseRun(args, options);
  };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(uploads, 2, '第一次 99991400 后应退避重试一次');
});

test('非频控错误不重试，直接进失败回退', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items, failOn: (args) => args[1] === '+media-upload' });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 1, '普通错误不应重试');
  assert.equal(store.completed.warnings.length, 1);
});

test('standalone anchor in a bullet block is located natively regardless of block type', async () => {
  const job = fakeJob({
    markdown: '# T\n\n- [[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  // 独占一个列表项的锚点：块文本 trim 后严格等于锚点，可以安全原生插入+删除
  const items = [
    containerBlock('doc1', '', 1, ['b0']),
    { block_id: 'b0', parent_id: 'doc1', block_type: 12, bullet: { elements: [{ text_run: { content: ' [[FEISHU_CLIP_IMAGE:0]] ' } }] } },
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(apiCalls(lark.calls, 'POST', '/blocks/doc1/children').length, 1, '独占列表项的锚点应走原生块操作');
  const deletes = apiCalls(lark.calls, 'DELETE', 'batch_delete').map(deleteBody);
  assert.deepEqual(deletes, [{ start_index: 1, end_index: 2 }]);
  assert.ok(!lark.calls.some((args) => args[1] === '+media-insert'));
});

// 图片三级降级（预览块 → 下载上传 → 纯链接）：公开 URL 图片直接建 iframe 预览块，
// 不下载不上传；无公开 URL 的字节图片走上传管线
test('公开 URL 图片建预览块，字节图片走上传管线', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [
      { label: 'preview', source: 'https://cdn.example.com/a.png' },
      { label: 'upload', bytesBase64: PNG_BYTES },
    ],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0', 'p1']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
    textBlock('p1', 'doc1', '[[FEISHU_CLIP_IMAGE:1]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  const inserts = apiCalls(lark.calls, 'POST', '/children');
  const previewInserts = inserts.filter((args) => args.join(' ').includes('"block_type":26'));
  assert.equal(previewInserts.length, 1, '公开 URL 图片建 iframe 预览块');
  assert.ok(previewInserts[0].join(' ').includes(encodeURIComponent('https://cdn.example.com/a.png')));
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 1, '只有字节图片上传');
  assert.ok(store.completed.timeline.some((entry) => entry.kind === 'image' && entry.name === 'image-1' && entry.detail === 'iframe-preview'), '预览块在时间线里留痕');
});

test('公开 URL 图片预览块管线不做下载和上传', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'preview', source: 'https://cdn.example.com/a.png' }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(apiCalls(lark.calls, 'GET', '/blocks').length, 1, '拉一次块列表定位锚点');
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 0, '预览块不上传');
  const [insert] = apiCalls(lark.calls, 'POST', '/children');
  const body = JSON.parse(insert[insert.indexOf('--data') + 1]);
  assert.equal(body.children[0].block_type, 26);
  assert.equal(body.children[0].iframe.component.iframe_type, 99);
  assert.equal(body.children[0].iframe.component.url, encodeURIComponent('https://cdn.example.com/a.png'));
});

test('预览块建块失败且有字节：转入下载上传管线落成真实图片块', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', source: 'https://cdn.example.com/a.png', bytesBase64: PNG_BYTES }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  // 只让预览块（block_type 26）建块失败，图片块（27）正常
  const lark = fakeLark({
    items,
    failOn: (args) => args[0] === 'api' && args[1] === 'POST' && args.join(' ').includes('"block_type":26'),
  });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, [], '第二级管线成功则无警告');
  const imageInserts = apiCalls(lark.calls, 'POST', '/children').filter((args) => args.join(' ').includes('"block_type":27'));
  assert.equal(imageInserts.length, 1, '预览失败后应建真实图片块');
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 1);
  assert.ok(!lark.calls.some((args) => args[1] === '+update' && args.includes('str_replace')), '下载上传成功就不应文本兜底');
});

test('预览块失败且下载也失败：退回纯文本原图链接', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', source: 'https://nonexistent.invalid/a.png' }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items, failOn: (args) => args[0] === 'api' && args[1] === 'POST' });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.ok(store.completed, '两级都失败不应拖垮任务');
  assert.equal(store.completed.warnings.length, 1);
  assert.match(store.completed.warnings[0], /图片 1/);
  assert.ok(lark.calls.some((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IMAGE:0]]')), '应退回 str_replace 文本兜底');
  assert.ok(lark.calls.some((args) => args.includes('原图链接') || args.some((arg) => String(arg).includes('nonexistent.invalid'))), '兜底文案含原图链接');
});

// 图片写入模式 download（#53）：跳过预览块 pass，公开 URL 图片也一律进下载上传管线
test('download 模式：公开 URL 图片不建预览块，直接走下载上传', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [
      { label: 'public', source: 'https://cdn.example.com/a.png', bytesBase64: PNG_BYTES },
      { label: 'upload', bytesBase64: PNG_BYTES },
    ],
  });
  job.imageMode = 'download';
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0', 'p1']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
    textBlock('p1', 'doc1', '[[FEISHU_CLIP_IMAGE:1]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  const inserts = apiCalls(lark.calls, 'POST', '/children');
  assert.ok(!inserts.some((args) => args.join(' ').includes('"block_type":26')), 'download 模式不建 iframe 预览块');
  assert.equal(inserts.filter((args) => args.join(' ').includes('"block_type":27')).length, 2, '两张图都建真实图片块');
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 2, '公开 URL 图片也上传');
});

test('download 模式：无字节公开图下载失败后退回原图链接文本，不建预览块', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', source: 'https://nonexistent.invalid/a.png' }],
  });
  job.imageMode = 'download';
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.ok(store.completed, '下载失败不应拖垮任务');
  assert.equal(store.completed.warnings.length, 1);
  assert.match(store.completed.warnings[0], /图片 1/);
  assert.ok(!apiCalls(lark.calls, 'POST', '/children').some((args) => args.join(' ').includes('"block_type":26')), 'download 模式不回退到预览块');
  assert.ok(lark.calls.some((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IMAGE:0]]')), '应退回 str_replace 文本兜底');
});

// off 等价于旧 includeImages=false：prepareMarkdown 已把锚点落成文本，图片阶段整体跳过
test('off 模式：不处理图片，不拉块列表、不建块、不上传', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'public', source: 'https://cdn.example.com/a.png' }],
  });
  job.imageMode = 'off';
  const store = fakeStore(job);
  const lark = fakeLark({ items: [] });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(apiCalls(lark.calls, 'GET', '/blocks').length, 0);
  assert.equal(apiCalls(lark.calls, 'POST', '/children').length, 0);
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 0);
  assert.ok(!store.completed.timeline.some((entry) => entry.kind === 'stage' && entry.name === 'images'), 'off 模式没有图片阶段');
});

// 存量任务兼容（#53）：旧 job 只有 includeImages 布尔——false 按不保存、true 按预览优先
test('存量 job 无 imageMode 字段：includeImages:false 按不保存处理', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'public', source: 'https://cdn.example.com/a.png' }],
  });
  delete job.imageMode;
  job.includeImages = false;
  const store = fakeStore(job);
  const lark = fakeLark({ items: [] });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(apiCalls(lark.calls, 'GET', '/blocks').length, 0, '不进入图片阶段');
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 0);
});

test('存量 job 无 imageMode 字段：includeImages:true 按预览优先处理', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'preview', source: 'https://cdn.example.com/a.png' }],
  });
  delete job.imageMode;
  job.includeImages = true;
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  const [insert] = apiCalls(lark.calls, 'POST', '/children');
  assert.equal(JSON.parse(insert[insert.indexOf('--data') + 1]).children[0].block_type, 26, '公开图建 iframe 预览块');
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 0);
});


// iframe 转写（#48）：占位符段落 → 飞书 iframe 块（block_type 26，与用户手动「预览视图」同型，
// spike 实测 children API 可创建）。建块插在锚点下标处、锚点顺延一位后删除；失败降级为链接并警告
function iframeJob(iframes) {
  const job = fakeJob({ markdown: '# T\n\n[[FEISHU_CLIP_IFRAME:0]]', images: [] });
  job.snapshot.iframes = iframes;
  return job;
}
function iframeAnchorItems() {
  return [containerBlock('doc1', '', 1, ['p0']), textBlock('p0', 'doc1', '[[FEISHU_CLIP_IFRAME:0]]')];
}

test('iframe 占位符转写为 block_type 26 并删除锚点段落', async () => {
  const url = 'https://labuladong.online/algo-visualize/tutorial/uf-native/';
  const job = iframeJob([{ url, title: '算法可视化 - uf-native' }]);
  const store = fakeStore(job);
  const lark = fakeLark({ items: iframeAnchorItems() });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  const [insert] = apiCalls(lark.calls, 'POST', '/children');
  const body = JSON.parse(insert[insert.indexOf('--data') + 1]);
  assert.equal(body.children[0].block_type, 26);
  assert.equal(body.children[0].iframe.component.iframe_type, 99);
  assert.equal(body.children[0].iframe.component.url, encodeURIComponent(url), 'url 需 encodeURIComponent（用户手动块的实测结构）');
  const [del] = apiCalls(lark.calls, 'DELETE', 'batch_delete');
  assert.deepEqual(deleteBody(del), { start_index: 1, end_index: 2 }, '建块后锚点顺延一位再删');
});

test('iframe 建块失败时降级为标题链接段落并警告', async () => {
  const job = iframeJob([{ url: 'https://example.test/widget/', title: '面板' }]);
  const store = fakeStore(job);
  const lark = fakeLark({ items: iframeAnchorItems(), failOn: (args) => args[0] === 'api' && args[1] === 'POST' && args[2].includes('/children') });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(store.completed.warnings.length, 1);
  assert.match(store.completed.warnings[0], /面板/);
  const fix = lark.calls.find((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IFRAME:0]]'));
  assert.ok(fix, '失败占位符应走 str_replace 回退');
  assert.equal(fix[fix.indexOf('--content') + 1], '[面板](https://example.test/widget/)');
});

test('iframe 占位符定位不到独立块时降级为链接并警告', async () => {
  const job = iframeJob([{ url: 'https://example.test/widget/', title: '面板' }]);
  const store = fakeStore(job);
  // 锚点混在其他文本里（非独立成块），locateAnchors 返回 null
  const items = [containerBlock('doc1', '', 1, ['p0']), textBlock('p0', 'doc1', '前缀 [[FEISHU_CLIP_IFRAME:0]] 后缀')];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(store.completed.warnings.length, 1);
  const fix = lark.calls.find((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IFRAME:0]]'));
  assert.ok(fix, '定位不到的占位符应 str_replace 成链接');
  assert.equal(fix[fix.indexOf('--content') + 1], '[面板](https://example.test/widget/)');
});

test('快照没有 iframes 字段时不拉块列表、零调用', async () => {
  const job = fakeJob({ markdown: '# T\n\n正文', images: [] });
  const store = fakeStore(job);
  const lark = fakeLark({ items: [] });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(apiCalls(lark.calls, 'GET', '/blocks').length, 0);
  assert.equal(apiCalls(lark.calls, 'POST', '/children').length, 0);
});

// code-review 发现的边界：listBlocks 等整体性失败不应把剪藏判死，剩余占位符全部降级为链接
test('iframe 阶段整体性失败（块列表拉取抛错）：占位符全部降级，任务仍完成', async () => {
  const job = iframeJob([{ url: 'https://example.test/widget/', title: '面板' }]);
  const store = fakeStore(job);
  const lark = fakeLark({ items: iframeAnchorItems(), failOn: (args) => args[0] === 'api' && args[1] === 'GET' && args[2].endsWith('/blocks') });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.ok(store.completed, '任务应完成而非失败');
  assert.equal(store.failed, null);
  assert.equal(store.completed.warnings.length, 1);
  const fix = lark.calls.find((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IFRAME:0]]'));
  assert.ok(fix, '占位符应降级为链接');
});

// ——— PDF 存云盘消费者（#65）：下载 → 落盘 scratch → lark-cli drive +upload → complete ———

import { pdfFileName } from '../src/bridge/executor.mjs';

test('pdfFileName：标题渲染结果 + .pdf；清洗文件名非法字符，逐级回退', () => {
  assert.equal(pdfFileName({ title: 'Attention Is All You Need', url: 'https://arxiv.org/pdf/1706.03762' }), 'Attention Is All You Need.pdf');
  assert.equal(pdfFileName({ title: 'a/b\\c:d*e?f"g<h>i|j', url: 'https://example.com/x' }), 'a-b-c-d-e-f-g-h-i-j.pdf', '非法字符替换为连字符');
  assert.equal(pdfFileName({ title: '', url: 'https://example.com/x', fallback: 'paper.pdf' }), 'paper.pdf', '空标题回退 pdfSource.name（不重复 .pdf）');
  assert.equal(pdfFileName({ title: '   ', url: 'https://arxiv.org/pdf/2401.00001' }), '2401.00001.pdf', '无标题无 name 回退 URL 末段');
  assert.equal(pdfFileName({ title: '', url: 'https://example.com/' }), 'clip.pdf', '全部落空时用通用占位');
  assert.equal(pdfFileName({ title: '标题结束...', url: 'https://example.com/x' }), '标题结束.pdf', '结尾点号剥除');
  assert.equal(pdfFileName({ title: '长'.repeat(300), url: 'https://example.com/x' }).length, 240 + 4, '标题截断 240 字符留足 .pdf 后缀');
});

// pdf 管道的假 store：记录 claim/complete/fail 的 kind 与产物；list 一次性吐出 pdf job。
// clipJob（#88）：get 带 clip kind 时返回的 clip job（引用回填查 documentId/pdfRefInserted 用）；
// markError/markClaimed：markPdfRefInserted 的故障/竞态注入（claimed 强制返回值）
function pdfFakeStore(job, { clipJob = null, markError = null, markClaimed = null } = {}) {
  let drained = false;
  let onSettled;
  const settled = new Promise((resolve) => { onSettled = resolve; });
  const store = {
    completed: null,
    failed: null,
    awaitedBytes: null,
    settled,
    claims: [],
    pdfRefMarks: [],
    async list() { return drained ? [] : [job]; },
    async claim(attemptId, workerId, kind) { store.claims.push({ attemptId, workerId, kind }); store.workerId = workerId; },
    async heartbeat() {},
    async get(attemptId, kind) { return kind === 'pdf' ? { status: 'running', workerId: store.workerId } : clipJob; },
    async complete(_id, _worker, result, kind) { store.completed = { ...result, kind }; drained = true; onSettled(); },
    async fail(_id, _worker, result, kind) { store.failed = { ...result, kind }; drained = true; onSettled(); },
    async awaitBytes(attemptId, workerId) { store.awaitedBytes = { attemptId, workerId }; drained = true; onSettled(); },
    async markPdfRefInserted(attemptId, inserted = true) {
      if (markError) throw markError;
      const was = clipJob?.pdfRefInserted === true;
      if (clipJob) clipJob.pdfRefInserted = inserted;
      store.pdfRefMarks.push({ attemptId, inserted });
      return { claimed: markClaimed ?? (inserted === true && !was) };
    },
  };
  return store;
}

const PDF_JOB = {
  attemptId: 'attempt-pdf',
  kind: 'pdf',
  title: 'Attention Is All You Need',
  sourceUrl: 'https://arxiv.org/abs/1706.03762',
  pdfSource: { type: 'url', url: 'https://arxiv.org/pdf/1706.03762', name: '1706.03762.pdf', sizeBytes: 2048 },
};

test('pdf job：下载后原格式落盘，经 drive +upload 上传云盘根目录，complete 带 fileToken/url', async () => {
  const store = pdfFakeStore({ ...PDF_JOB });
  const uploads = [];
  const downloads = [];
  const lark = {
    async uploadDriveFile(options) {
      uploads.push(options);
      return { fileToken: 'ft-pdf', url: 'https://example.feishu.cn/file/ft-pdf' };
    },
  };
  const downloadPdf = async (url) => {
    downloads.push(url);
    return { buffer: Buffer.from('%PDF-1.7 fake', 'latin1'), source: url, sizeBytes: 15 };
  };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
  await store.settled;

  assert.deepEqual(downloads, ['https://arxiv.org/pdf/1706.03762'], '按 pdfSource.url 下载');
  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0].kind, 'pdf', 'claim 带 pdf kind');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].localFileName, 'Attention Is All You Need.pdf', '落盘文件名 = 标题渲染结果 + .pdf');
  assert.equal(uploads[0].displayName, 'Attention Is All You Need.pdf', '云盘展示名同一');
  assert.equal(uploads[0].folderToken, null, 'job 无 folderToken（存量/#65 前）走云盘根目录');
  assert.ok(uploads[0].cwd, '落盘在 scratch 目录上传（--file 只接受 cwd 内相对路径）');
  assert.ok(!path.isAbsolute(uploads[0].localFileName), 'localFileName 必须是相对路径');
  assert.equal(store.completed.kind, 'pdf');
  assert.deepEqual(store.completed.document, { fileToken: 'ft-pdf', url: 'https://example.feishu.cn/file/ft-pdf' });
  assert.ok(store.completed.timeline.some((entry) => entry.kind === 'stage' && entry.name === 'pdf_download'), '下载阶段计时');
  assert.ok(store.completed.timeline.some((entry) => entry.kind === 'cli' && entry.name === 'drive +upload'), '上传计时');
  assert.equal(store.failed, null);
});

test('pdf job：job.folderToken（picker 选定的目录，#66）透传给 drive +upload', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-folder', folderToken: 'fld-papers' });
  const uploads = [];
  const lark = { async uploadDriveFile(options) { uploads.push(options); return { fileToken: 'f', url: 'https://u' }; } };
  const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
  await store.settled;
  assert.equal(uploads[0].folderToken, 'fld-papers', 'executor 以 job 上的 folderToken 调 lark-cli');
  assert.equal(store.completed?.kind, 'pdf');
});

test('pdf job：空标题时文件名回退 pdfSource.name', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, title: null });
  const uploads = [];
  const lark = { async uploadDriveFile(options) { uploads.push(options); return { fileToken: 'f', url: 'https://u' }; } };
  const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
  await store.settled;
  assert.equal(uploads[0].localFileName, '1706.03762.pdf');
});

test('pdf job：下载超限/类型不符映射为中文失败文案，上传歧义一律按失败（fail 落 failed）', async () => {
  for (const [code, expected] of [
    ['PDF_SIZE_REJECTED', /超过大小上限/],
    ['PDF_TYPE_REJECTED', /不是 PDF 文件/],
    ['PDF_SSRF_REJECTED', /地址不安全/],
  ]) {
    const store = pdfFakeStore({ ...PDF_JOB, attemptId: `pdf-${code}` });
    const lark = { async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; } };
    const downloadPdf = async () => { throw Object.assign(new Error(code), { code }); };
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
    await store.settled;
    assert.equal(store.failed?.kind, 'pdf');
    assert.equal(store.failed?.stage, 'pdf', 'pdf 失败阶段固定为 pdf（下载上传不加区分）');
    assert.match(store.failed?.error, expected);
    assert.equal(store.completed, null);
  }

  // 上传侧失败（含超时歧义）：不查重不 reconcile，直接 failed
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-upload-fail' });
  const lark = { async uploadDriveFile() { throw new Error('socket hang up'); } };
  const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
  await store.settled;
  assert.equal(store.failed?.stage, 'pdf');
  assert.equal(store.failed?.error, 'socket hang up', '未识别的上传错误透传原始消息');
});

// ——— 凭据回退（#68）：url 型撞 401/403 转 awaiting_bytes；bytes 型走 staging 上传 ———

test('pdf job：下载撞 401/403 或 IEEE 验证响应不 fail，转 awaiting_bytes（其余 HTTP 错误仍 fail）', async () => {
  for (const statusCode of [401, 403]) {
    const store = pdfFakeStore({ ...PDF_JOB, attemptId: `pdf-${statusCode}` });
    const lark = { async uploadDriveFile() { throw new Error('不应走到上传'); } };
    const downloadPdf = async () => { throw Object.assign(new Error(`PDF_HTTP_${statusCode}`), { code: 'PDF_FETCH_FAILED', statusCode }); };
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf }).kick();
    await store.settled;
    assert.ok(store.awaitedBytes, `${statusCode} 应转 awaiting_bytes`);
    assert.equal(store.awaitedBytes.attemptId, `pdf-${statusCode}`);
    assert.equal(store.failed, null, `${statusCode} 不得落 failed`);
    assert.equal(store.completed, null);
  }

  for (const statusCode of [202, 418]) {
    const sourceUrl = 'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=11146309&ref=';
    const store = pdfFakeStore({ ...PDF_JOB, attemptId: `pdf-ieee-${statusCode}`, pdfSource: { ...PDF_JOB.pdfSource, url: sourceUrl } });
    const lark = { async uploadDriveFile() { throw new Error('不应走到上传'); } };
    const downloadPdf = async () => {
      throw Object.assign(new Error(`PDF_HTTP_${statusCode}`), {
        code: 'PDF_FETCH_FAILED', statusCode, challenge: statusCode === 202,
      });
    };
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf }).kick();
    await store.settled;
    assert.ok(store.awaitedBytes, `IEEE HTTP ${statusCode} 应转 awaiting_bytes`);
    assert.equal(store.failed, null);
  }

  // 对照组：404 等其他 HTTP 错误仍按失败处理
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-404' });
  const lark = { async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; } };
  const downloadPdf = async () => { throw Object.assign(new Error('PDF_HTTP_404'), { code: 'PDF_FETCH_FAILED', statusCode: 404 }); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf }).kick();
  await store.settled;
  assert.equal(store.awaitedBytes, null);
  assert.equal(store.failed?.stage, 'pdf');
  assert.match(store.failed?.error, /PDF_HTTP_404/);
});

test('pdf job：Bridge 连接超时经有限重试后转 awaiting_bytes，由浏览器回传字节（#105）', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-connect-timeout' });
  const lark = { async uploadDriveFile() { throw new Error('不应走到上传'); } };
  let calls = 0;
  const downloadPdf = async () => {
    calls += 1;
    throw Object.assign(new Error('PDF_CONNECT_TIMEOUT'), { code: 'PDF_FETCH_FAILED', failureType: 'transport' });
  };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf, sleep }).kick();
  await store.settled;

  assert.equal(calls, 3, '网络传输错误仍执行既有有限重试');
  assert.deepEqual(sleeps, [1000, 3000]);
  assert.ok(store.awaitedBytes, '重试耗尽后进入浏览器字节回传');
  assert.equal(store.failed, null);
});

// ——— 瞬时网络错误重试：ECONNRESET 类裸系统错误码自动重试（最多 2 次）；PDF_* 业务失败绝不重试 ———

test('pdf job：下载撞瞬时网络错误（ECONNRESET）自动重试，第二次成功后 job succeeded', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-retry' });
  const lark = { async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; } };
  let calls = 0;
  const downloadPdf = async (url) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return { buffer: Buffer.from('%PDF-'), source: url, sizeBytes: 5 };
  };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf, sleep }).kick();
  await store.settled;

  assert.equal(calls, 2, '首次 ECONNRESET 后重试一次成功');
  assert.deepEqual(sleeps, [1000], '首次退避约 1s');
  assert.equal(store.completed?.kind, 'pdf');
  assert.equal(store.failed, null);
  assert.ok(store.completed.timeline.some((entry) => entry.kind === 'retry' && entry.name === 'pdf_download'), 'timeline 记一笔重试');
});

test('pdf job：连续 3 次旧式瞬时网络错误最终转 awaiting_bytes（共 3 次尝试，退避约 1s/3s）', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-retry-exhausted' });
  const lark = { async uploadDriveFile() { throw new Error('不应走到上传'); } };
  let calls = 0;
  const downloadPdf = async () => { calls += 1; throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf, sleep }).kick();
  await store.settled;

  assert.equal(calls, 3, '最多 2 次重试（共 3 次尝试）');
  assert.deepEqual(sleeps, [1000, 3000], '退避约 1s / 3s');
  assert.ok(store.awaitedBytes, '兼容未携带 failureType 的系统网络错误');
  assert.equal(store.failed, null);
  assert.equal(store.completed, null);
});

test('pdf job：HTTP 业务错误绝不重试（401/403 仍走 awaiting_bytes 既有路径）', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-403-noretry' });
  const lark = { async uploadDriveFile() { throw new Error('不应走到上传'); } };
  let calls = 0;
  const downloadPdf = async () => { calls += 1; throw Object.assign(new Error('PDF_HTTP_403'), { code: 'PDF_FETCH_FAILED', statusCode: 403 }); };
  const sleep = async () => { throw new Error('业务失败不得触发退避'); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf, sleep }).kick();
  await store.settled;

  assert.equal(calls, 1, 'PDF_FETCH_FAILED 不重试');
  assert.ok(store.awaitedBytes, '403 语义不变：转 awaiting_bytes');
  assert.equal(store.failed, null);
  assert.equal(store.completed, null);
});

// ——— PDF 云盘引用回填（#88）：pdf job 上传成功后，把 PDF 以「@」引用（mention_doc）
// 插到本次 clip 文档开头的引用容器；幂等靠 clip job 的 pdfRefInserted 标记 ———

const CLIP_WITH_DOC = {
  kind: 'clip',
  status: 'succeeded',
  document: { documentId: 'doc-1', url: 'https://example.feishu.cn/docx/doc-1' },
  pdfRefInserted: false,
};

test('pdf job：上传成功后把 PDF 以 mention_doc 引用插到 clip 文档开头，先置位再插入（mark-before-insert）', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-ref' }, { clipJob: { ...CLIP_WITH_DOC } });
  const order = [];
  const refs = [];
  const lark = {
    async uploadDriveFile() { order.push('upload'); return { fileToken: 'ft-pdf', url: 'https://example.feishu.cn/file/ft-pdf' }; },
    async insertDocFileReference(options) { order.push('insert'); refs.push(options); },
  };
  const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
  await store.settled;

  assert.deepEqual(order, ['upload', 'insert'], '先上传成功，再插入引用');
  assert.deepEqual(refs, [{
    documentId: 'doc-1',
    fileToken: 'ft-pdf',
    fileUrl: 'https://example.feishu.cn/file/ft-pdf',
    name: 'Attention Is All You Need.pdf',
  }], '引用参数：clip 的 documentId + 上传产物 fileToken/url + 云盘文件名');
  // mark-before-insert：置位在插入之前，重排竞态下另一执行体读到已置位会跳过
  assert.deepEqual(store.pdfRefMarks, [{ attemptId: 'pdf-ref', inserted: true }]);
  assert.equal(store.completed?.kind, 'pdf');
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(store.failed, null);
});

test('pdf job：不产生引用的情形静默跳过（已插过/无 clip job/clip 失败终态无文档）', async () => {
  const cases = [
    ['已插过（pdfRefInserted）', { ...CLIP_WITH_DOC, pdfRefInserted: true }],
    ['PDF 标签页直存云盘（无 clip job）', null],
    ['clip 失败终态（无 document）', { kind: 'clip', status: 'failed', document: null, pdfRefInserted: false }],
  ];
  for (const [index, [label, clipJob]] of cases.entries()) {
    const store = pdfFakeStore({ ...PDF_JOB, attemptId: `pdf-ref-skip-${index}` }, { clipJob });
    let inserted = 0;
    const lark = {
      async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; },
      async insertDocFileReference() { inserted += 1; },
    };
    const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
    await store.settled;
    assert.equal(inserted, 0, `${label}：不应插入引用`);
    assert.equal(store.pdfRefMarks.length, 0, `${label}：不写幂等标记`);
    assert.equal(store.completed?.kind, 'pdf', `${label}：上传仍正常完成`);
    assert.deepEqual(store.completed.warnings, [], `${label}：静默跳过，不记警告`);
  }
});

test('pdf job：clip 文档尚未建好（非终态无 document）→ 跳过插入并记警告（协议空隙，不自动补插）', async () => {
  for (const status of ['queued', 'running', 'reconciling']) {
    const clipJob = { kind: 'clip', status, document: null, pdfRefInserted: false };
    const store = pdfFakeStore({ ...PDF_JOB, attemptId: `pdf-ref-pending-${status}` }, { clipJob });
    let inserted = 0;
    const lark = {
      async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; },
      async insertDocFileReference() { inserted += 1; },
    };
    const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
    await store.settled;
    assert.equal(inserted, 0, `clip ${status}：不插入`);
    assert.equal(store.pdfRefMarks.length, 0, `clip ${status}：不置位（clip 建档后 pdf 重试可补插）`);
    assert.equal(store.completed?.kind, 'pdf');
    assert.equal(store.completed.warnings.length, 1, `clip ${status}：记一条可见警告`);
    assert.match(store.completed.warnings[0], /clip 文档尚未建好/);
  }
});

test('pdf job：abort 策略下 clip 正在等 PDF，暂未建档不记误导性引用警告', async () => {
  const clipJob = { kind: 'clip', status: 'running', document: null, pdfFailurePolicy: 'abort', pdfRefInserted: false };
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-ref-abort-wait' }, { clipJob });
  const lark = {
    async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; },
    async insertDocFileReference() { throw new Error('不应在 clip 建档前插入'); },
  };
  const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
});

test('pdf job：重排竞态——mark 返回 claimed=false（另一执行体已置位）→ 跳过插入不双插', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-ref-race' }, { clipJob: { ...CLIP_WITH_DOC }, markClaimed: false });
  let inserted = 0;
  const lark = {
    async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; },
    async insertDocFileReference() { inserted += 1; },
  };
  const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
  await store.settled;
  assert.equal(inserted, 0, '置位被抢先则不插入');
  assert.equal(store.completed?.kind, 'pdf');
  assert.deepEqual(store.completed.warnings, [], '竞态跳过不记警告');
});

test('pdf job：幂等标记置位失败（store 异常）→ 不插入，记警告，job 仍 succeeded', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-ref-mark-fail' },
    { clipJob: { ...CLIP_WITH_DOC }, markError: new Error('jobs.json 写失败') });
  let inserted = 0;
  const lark = {
    async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; },
    async insertDocFileReference() { inserted += 1; },
  };
  const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
  await store.settled;
  assert.equal(inserted, 0, '置位失败不得插入');
  assert.equal(store.failed, null);
  assert.equal(store.completed?.kind, 'pdf');
  assert.equal(store.completed.warnings.length, 1);
  assert.match(store.completed.warnings[0], /jobs\.json 写失败/, '警告透传置位失败的原始消息');
});

test('pdf job：引用插入失败清除幂等标记并记警告，job 仍 succeeded，上传产物保留', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-ref-fail' }, { clipJob: { ...CLIP_WITH_DOC } });
  const lark = {
    async uploadDriveFile() { return { fileToken: 'ft-pdf', url: 'https://example.feishu.cn/file/ft-pdf' }; },
    async insertDocFileReference() { throw new Error('docx api 999'); },
  };
  const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf }).kick();
  await store.settled;

  assert.equal(store.failed, null, '插入失败不得 fail job');
  assert.equal(store.completed?.kind, 'pdf');
  assert.deepEqual(store.completed.document, { fileToken: 'ft-pdf', url: 'https://example.feishu.cn/file/ft-pdf' }, '上传产物照常落库');
  assert.equal(store.completed.warnings.length, 1, '失败警告随 result.warnings 落库');
  assert.match(store.completed.warnings[0], /引用插入失败/);
  assert.deepEqual(store.pdfRefMarks, [
    { attemptId: 'pdf-ref-fail', inserted: true },
    { attemptId: 'pdf-ref-fail', inserted: false },
  ], '先置位、插入失败后清除标记（重试可补插），不与插入失败混为同一条 catch 误报');
});

test('pdf job：bytes 型从 staging 取字节上传（不下载），终态清理 staging', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-exec-staging-'));
  const stagingDir = path.join(directory, 'staging');
  const staging = new PdfChunkStaging({ dir: stagingDir });
  const body = Buffer.from('%PDF-1.7 staged bytes', 'latin1');
  const attemptId = 'pdf-bytes-job';
  await staging.putChunk(attemptId, 0, body);
  try {
    const store = pdfFakeStore({
      ...PDF_JOB,
      attemptId,
      pdfSource: { type: 'bytes', url: PDF_JOB.pdfSource.url, name: '1706.03762.pdf', sizeBytes: body.length, totalChunks: 1, sha256: 'e'.repeat(64) },
    });
    const uploads = [];
    const lark = { async uploadDriveFile(options) { uploads.push(options); return { fileToken: 'ft-b', url: 'https://u' }; } };
    let downloads = 0;
    const downloadPdf = async () => { downloads += 1; throw new Error('bytes 型不得走 URL 下载'); };
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf, staging }).kick();
    await store.settled;

    assert.equal(downloads, 0, '字节来自 staging 而非 URL 下载');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].localFileName, 'Attention Is All You Need.pdf');
    // 上传的文件内容就是 staging 字节（scratch 已删，用 copyFile 目标之外的旁证：上传被调用即路径通）
    assert.equal(store.completed.kind, 'pdf');
    assert.ok(store.completed.timeline.some((entry) => entry.kind === 'stage' && entry.name === 'pdf_staging'), 'staging 阶段计时');
    assert.ok(!store.completed.timeline.some((entry) => entry.name === 'pdf_download'), '无下载阶段');
    const leftovers = async () => (await readdir(stagingDir).catch(() => [])).filter((entry) => entry.startsWith(attemptId));
    // complete 落盘先于 finally 的 staging discard，等收尾完成再断言
    for (let count = 0; count < 100 && (await leftovers()).length > 0; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(await leftovers(), [], '终态后 staging 已清理');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pdf job：bytes 型终态时同次 clip 仍非终态 → staging 保留给摘要阶段（#99 续竞态）', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-exec-staging-keep-'));
  const stagingDir = path.join(directory, 'staging');
  const staging = new PdfChunkStaging({ dir: stagingDir });
  const body = Buffer.from('%PDF-1.7 staged bytes', 'latin1');
  const attemptId = 'pdf-bytes-clip-open';
  await staging.putChunk(attemptId, 0, body);
  try {
    // clip 仍在跑（running）：摘要阶段可能还没开始等字节，staging 不能随 pdf 终态清掉
    const store = pdfFakeStore(
      {
        ...PDF_JOB,
        attemptId,
        pdfSource: { type: 'bytes', url: PDF_JOB.pdfSource.url, name: '1706.03762.pdf', sizeBytes: body.length, totalChunks: 1, sha256: 'e'.repeat(64) },
      },
      { clipJob: { kind: 'clip', attemptId, status: 'running', document: null } },
    );
    const lark = { async uploadDriveFile() { return { fileToken: 'ft-b', url: 'https://u' }; } };
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf: async () => { throw new Error('bytes 型不得走 URL 下载'); }, staging }).kick();
    await store.settled;
    // complete 落盘先于 finally 的保留判定，等收尾跑完再断言
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(store.completed.kind, 'pdf');
    const leftovers = (await readdir(stagingDir)).filter((entry) => entry.startsWith(attemptId));
    assert.ok(leftovers.includes(`${attemptId}.part`), 'clip 非终态时 staging 字节保留');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ——— AI 摘要阶段（#75）：claim 之后、prepareMarkdown 之前；失败降级不 fail；digestText 缓存复用 ———

import { readFile } from 'node:fs/promises';

// 无图片的 clip job（imageMode off 跳过图片阶段）；假 lark 在 docs +create 时读出
// 落盘的 content.md（摘要是经 applyDigest 注入后再 prepareMarkdown，直接验证最终正文）。
// digest 缺省钉 mode:'inline'（#75 既有语义的回归组；#98 起缺省读作 subdoc，子文档模式
// 另有专用 rig，见文末 subdocSetup）
function digestSetup({ markdown, digest = null, digestText = null, pdfSource = null }) {
  const job = fakeJob({ markdown, images: [] });
  job.imageMode = 'off';
  if (digest) job.digest = { mode: 'inline', ...digest };
  if (digestText !== null) job.digestText = digestText;
  job.pdfSource = pdfSource;
  const store = fakeStore(job);
  const contents = [];
  const lark = {
    async run(args, options) {
      if (args.includes('@content.md')) contents.push(await readFile(path.join(options.cwd, 'content.md'), 'utf8'));
      return { ok: true, data: { document: { document_id: 'doc1', url: 'https://doc1' } } };
    },
  };
  return { store, lark, contents };
}

const AI_CONFIG = { apiType: 'responses', baseUrl: 'https://api.example.com/v1', model: 'gpt-5', apiKey: 'sk-t' };

test('AI 摘要：开启后生成摘要原位替换 {{digest}}，结果经 recordDigest 落库缓存', async () => {
  let calls = 0;
  const generateDigest = async ({ config, instruction, content }) => {
    calls += 1;
    assert.deepEqual(config, AI_CONFIG, 'config 来自 getAiConfig');
    assert.equal(instruction, '总结成三点');
    assert.equal(content, '# T\n\n前文 {{digest}} 后文', '正文原样（含占位符）喂给 AI');
    return 'AI 要点';
  };
  const { store, lark, contents } = digestSetup({
    markdown: '# T\n\n前文 {{digest}} 后文',
    digest: { enabled: true, instruction: '总结成三点' },
  });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.equal(calls, 1);
  assert.equal(store.digestRecorded, 'AI 要点', '摘要结果落库缓存');
  assert.equal(contents.length, 1);
  assert.match(contents[0], /前文 AI 要点 后文/, '占位符原位替换');
  assert.doesNotMatch(contents[0], /\{\{\s*digest\s*\}\}/);
  assert.doesNotMatch(contents[0], /# Digest/, '占位符替换不含默认标题（标题只由默认布局添加）');
  assert.deepEqual(store.completed.warnings, []);
  assert.ok(store.completed.timeline.some((entry) => entry.kind === 'stage' && entry.name === 'digest' && typeof entry.ms === 'number'), 'digest 阶段计时');
});

test('AI 摘要：模板无占位符时注入 # Digest / # RAW content 默认布局', async () => {
  const { store, lark, contents } = digestSetup({
    markdown: '# T\n\n正文',
    digest: { enabled: true, instruction: '总结' },
  });
  const generateDigest = async () => 'AI 要点';
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.match(contents[0], /# Digest\n\nAI 要点\n\n# RAW content\n\n# T\n\n正文/, '默认两节布局');
});

test('AI 摘要：生成失败不拖垮剪藏——占位符置空、警告并入 warnings、job 仍成功', async () => {
  const { store, lark, contents } = digestSetup({
    markdown: '# T\n\n前文 {{digest}} 后文',
    digest: { enabled: true, instruction: '总结' },
  });
  const generateDigest = async () => { throw Object.assign(new Error('invalid key'), { code: 'AI_AUTH_FAILED' }); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.ok(store.completed, 'digest 失败不 fail job（部分成功降级）');
  assert.equal(store.failed, null);
  assert.equal(store.completed.warnings.length, 1);
  assert.equal(store.completed.warnings[0], 'AI 摘要生成失败：AI API 密钥无效或没有权限');
  assert.match(contents[0], /前文 {2}后文/, '占位符置空');
  assert.equal(store.digestRecorded, null, '失败不写缓存');
  const entry = store.completed.timeline.find((item) => item.kind === 'stage' && item.name === 'digest');
  assert.ok(entry?.detail, '失败在 timeline 留 detail');
});

test('AI 摘要：digestText 已缓存时重跑不调 AI，直接复用缓存', async () => {
  const { store, lark, contents } = digestSetup({
    markdown: '# T\n\n正文',
    digest: { enabled: true, instruction: '总结' },
    digestText: '缓存摘要',
  });
  let calls = 0;
  const generateDigest = async () => { calls += 1; throw new Error('缓存命中不得调 AI'); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.equal(calls, 0, '缓存命中不再调 AI');
  assert.match(contents[0], /# Digest\n\n缓存摘要\n\n# RAW content/, '缓存摘要走默认布局');
  assert.deepEqual(store.completed.warnings, []);
});

test('AI 摘要：开关关时行为与现状一致——不调 AI、不动正文、无 digest 阶段', async () => {
  const { store, lark, contents } = digestSetup({ markdown: '# T\n\n正文' });
  let calls = 0;
  const generateDigest = async () => { calls += 1; throw new Error('开关关不得调 AI'); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.equal(calls, 0);
  assert.match(contents[0], /# T\n\n正文/);
  assert.doesNotMatch(contents[0], /# Digest/);
  assert.deepEqual(store.completed.warnings, []);
  assert.ok(!store.completed.timeline.some((entry) => entry.name === 'digest'), '开关关没有 digest 阶段');
});

// ——— 摘要进度内存表（#86）：流式 onProgress 逐次更新 attemptId → { phase, tokens }；
// 纯内存不落盘，clip 终态后清理 ———

test('AI 摘要进度（#86）：onProgress 更新内存表供 job 视图合并；job 终态后条目清理', async () => {
  const { store, lark } = digestSetup({
    markdown: '# T\n\n正文',
    digest: { enabled: true, instruction: '总结' },
  });
  const observed = [];
  let executor;
  const generateDigest = async ({ onProgress }) => {
    assert.equal(typeof onProgress, 'function', 'executor 必须传 onProgress');
    assert.deepEqual(executor.digestProgressOf('attempt-pipe'), { phase: 'thinking', tokens: 0 }, '调 AI 前已建初始条目（先思考）');
    onProgress({ phase: 'thinking', tokens: 5 });
    observed.push(executor.digestProgressOf('attempt-pipe'));
    onProgress({ phase: 'writing', tokens: 12 });
    observed.push(executor.digestProgressOf('attempt-pipe'));
    return '要点';
  };
  executor = new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG });
  executor.kick();
  await store.settled;

  assert.deepEqual(observed, [
    { phase: 'thinking', tokens: 5 },
    { phase: 'writing', tokens: 12 },
  ], 'delta 逐次更新内存表（读出来的是快照副本）');
  assert.equal(store.digestRecorded, '要点', '摘要照常落库');
  // complete 落盘先于 finally 的进度清理，等收尾完成再断言
  for (let count = 0; count < 100 && executor.digestProgressOf('attempt-pipe') !== null; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(executor.digestProgressOf('attempt-pipe'), null, 'clip 终态后进度条目已清理');
});

test('AI 摘要进度（#86）：开关关 / digestText 缓存命中 / 摘要失败都不留进度条目', async () => {
  // 开关关：从不建条目
  const off = digestSetup({ markdown: '# T\n\n正文' });
  const offExecutor = new ClipExecutor({ store: off.store, lark: off.lark, logger: { warn() {}, error() {} }, generateDigest: async () => 'x', getAiConfig: async () => AI_CONFIG });
  offExecutor.kick();
  await off.store.settled;
  assert.equal(offExecutor.digestProgressOf('attempt-pipe'), null);

  // 缓存命中：不调 AI，不建条目
  const cached = digestSetup({ markdown: '# T\n\n正文', digest: { enabled: true, instruction: '总结' }, digestText: '缓存摘要' });
  const cachedExecutor = new ClipExecutor({ store: cached.store, lark: cached.lark, logger: { warn() {}, error() {} }, generateDigest: async () => 'x', getAiConfig: async () => AI_CONFIG });
  cachedExecutor.kick();
  await cached.store.settled;
  assert.equal(cachedExecutor.digestProgressOf('attempt-pipe'), null);

  // 摘要失败：job 仍成功（降级），终态后条目同样清理
  const failed = digestSetup({ markdown: '# T\n\n正文', digest: { enabled: true, instruction: '总结' } });
  const failedExecutor = new ClipExecutor({
    store: failed.store, lark: failed.lark, logger: { warn() {}, error() {} },
    generateDigest: async ({ onProgress }) => { onProgress({ phase: 'writing', tokens: 3 }); throw Object.assign(new Error('boom'), { code: 'AI_REQUEST_FAILED' }); },
    getAiConfig: async () => AI_CONFIG,
  });
  failedExecutor.kick();
  await failed.store.settled;
  assert.ok(failed.store.completed, '摘要失败不 fail job');
  // complete 落盘先于 finally 的进度清理，等收尾完成再断言
  for (let count = 0; count < 100 && failedExecutor.digestProgressOf('attempt-pipe') !== null; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(failedExecutor.digestProgressOf('attempt-pipe'), null, '失败终态同样清理');
});

// ——— provider 按名解析（#78）：digest.provider 交给 getAiConfig；悬空引用降级不调 AI ———

test('AI 摘要（#78）：预设指定 provider 时按名取配置；未指定传 null（默认语义）', async () => {
  const asked = [];
  const getAiConfig = async (name) => { asked.push(name); return AI_CONFIG; };
  const generateDigest = async () => '要点';

  const named = digestSetup({ markdown: '# T\n\n正文', digest: { enabled: true, instruction: '总结', provider: 'ds' } });
  new ClipExecutor({ store: named.store, lark: named.lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig }).kick();
  await named.store.settled;
  assert.deepEqual(asked, ['ds'], '按 digest.provider 名取配置');
  assert.match(named.contents[0], /# Digest\n\n要点/, '摘要照常生成');

  const plain = digestSetup({ markdown: '# T\n\n正文', digest: { enabled: true, instruction: '总结' } });
  new ClipExecutor({ store: plain.store, lark: plain.lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig }).kick();
  await plain.store.settled;
  assert.deepEqual(asked, ['ds', null], '未指定 provider 传 null（= 默认 provider）');
});

test('AI 摘要（#78）：provider 不存在 → 剪藏成功、占位符置空、warning 指明 provider 名，不调 AI', async () => {
  const { store, lark, contents } = digestSetup({
    markdown: '# T\n\n前文 {{digest}} 后文',
    digest: { enabled: true, instruction: '总结', provider: 'ghost' },
  });
  let calls = 0;
  const generateDigest = async () => { calls += 1; return 'x'; };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async (name) => (name === 'ghost' ? null : AI_CONFIG) }).kick();
  await store.settled;

  assert.ok(store.completed, '悬空 provider 不 fail job');
  assert.equal(calls, 0, 'provider 缺失不调 AI');
  assert.equal(store.digestRecorded, null, '不写缓存');
  assert.deepEqual(store.completed.warnings, ['AI provider「ghost」不存在（可能已被删除），本次未生成摘要']);
  assert.doesNotMatch(contents[0], /\{\{\s*digest\s*\}\}/, '占位符置空');
  const entry = store.completed.timeline.find((item) => item.kind === 'stage' && item.name === 'digest');
  assert.ok(entry?.detail?.includes('ghost'), 'timeline 留 detail');
});

// ——— 租约心跳（#89）：digest/下载/CLI 等长阶段动辄超过 60s 租约（glm reasoning 摘要实测
// 180s+），执行期间按 heartbeatMs 周期续约，防 recoverExpired 把活跃任务误重排（摘要重复执行、
// 原执行体收尾被拒「Only the active worker」）；心跳失败 = 租约真被收走 → 安全中止不写库 ———

test('租约心跳（#89）：长 digest 期间周期性续约，执行结束后心跳停止', async () => {
  const { store, lark } = digestSetup({ markdown: '# T\n\n正文', digest: { enabled: true, instruction: '总结' } });
  let heartbeats = 0;
  store.heartbeat = async () => { heartbeats += 1; };
  const generateDigest = () => new Promise((resolve) => setTimeout(() => resolve('要点'), 60));
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG, heartbeatMs: 10 }).kick();
  await store.settled;

  assert.ok(heartbeats >= 3, `60ms digest + 10ms 心跳应续约多次，实际 ${heartbeats}`);
  const stopped = heartbeats;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(heartbeats, stopped, '执行结束后心跳计时器已停');
});

test('租约心跳（#89）：心跳失败（租约丢失）→ 安全中止，不写摘要缓存/不建档/不落终态', async () => {
  const { store, lark } = digestSetup({ markdown: '# T\n\n正文', digest: { enabled: true, instruction: '总结' } });
  // 租约丢失 = 任务已被别的执行体接管/重排：建模为心跳抛错后任务不再处于 queued
  let stolen = false;
  const realList = store.list.bind(store);
  store.list = async (...args) => (stolen ? [] : realList(...args));
  store.heartbeat = async () => { stolen = true; throw new Error('lease lost'); };
  let digestResolved = false;
  const generateDigest = () => new Promise((resolve) => setTimeout(() => { digestResolved = true; resolve('要点'); }, 60));
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG, heartbeatMs: 10 }).kick();
  // 中止路径不落任何终态，settled 不 resolve，等固定时长后断言
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.ok(digestResolved, '在途 digest 请求跑完（无法取消），但结果不得再写库');
  assert.equal(store.digestRecorded, null, '租约丢失不写摘要缓存');
  assert.equal(store.completed, null, '不写 complete');
  assert.equal(store.failed, null, '不 fail（由接管的新执行体负责）');
});

test('租约心跳（#89）：pdf job 长下载期间同样周期性续约', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-heartbeat' });
  let heartbeats = 0;
  store.heartbeat = async () => { heartbeats += 1; };
  const lark = { async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; } };
  const downloadPdf = () => new Promise((resolve) => setTimeout(() => resolve({ buffer: Buffer.from('%PDF-'), source: PDF_JOB.pdfSource.url, sizeBytes: 5 }), 50));
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf, heartbeatMs: 10 }).kick();
  await store.settled;

  assert.ok(heartbeats >= 2, `pdf 下载期间应续约，实际 ${heartbeats}`);
  assert.equal(store.completed?.kind, 'pdf');
});

// ——— 双通道消费（#91）：clip 通道串行（防 wiki 建档竞争），pdf 独立通道与 clip 并行——
// pdf 不再等 clip 的长摘要/建档，同批任务总耗时 ≈ max(两者) 而非 sum ———

test('双通道（#91）：pdf 与 clip 并行消费，pdf 不等 clip 的长摘要先完成', async () => {
  const clipJob = {
    ...fakeJob({ markdown: '# T\n\n正文', images: [] }),
    kind: 'clip', attemptId: 'lane-clip', imageMode: 'off',
    digest: { enabled: true, instruction: '总结', mode: 'inline' },
  };
  const pdfJob = { ...PDF_JOB, attemptId: 'lane-pdf' };
  const queued = new Set([clipJob.attemptId, pdfJob.attemptId]);
  const done = {};
  let onBoth;
  const both = new Promise((resolve) => { onBoth = resolve; });
  const store = {
    async list() { return [clipJob, pdfJob].filter((job) => queued.has(job.attemptId)); },
    async claim() {},
    async heartbeat() {},
    async beginCreate() {},
    async recordDocument() {},
    async recordDigest() {},
    async get() { return { status: 'succeeded' }; },
    async complete(attemptId) {
      done[attemptId] = Date.now();
      queued.delete(attemptId);
      if (queued.size === 0) onBoth();
    },
    async fail(_id, _w, result) { throw new Error(`不得失败: ${JSON.stringify(result)}`); },
  };
  const lark = {
    async run() { return { ok: true, data: { document: { document_id: 'doc1', url: 'https://doc1' } } }; },
    async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; },
  };
  const downloadPdf = async () => ({ buffer: Buffer.from('%PDF-'), source: pdfJob.pdfSource.url, sizeBytes: 5 });
  const generateDigest = () => new Promise((resolve) => setTimeout(() => resolve('要点'), 60));
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await both;

  assert.ok(done['lane-pdf'] && done['lane-clip'], '两个任务都完成');
  assert.ok(done['lane-pdf'] < done['lane-clip'], 'pdf 不等 clip 的 60ms 摘要，并行先完成');
});

test('双通道（#91）：两个 clip 任务仍严格串行（后一个等前一个完成才开始）', async () => {
  const order = [];
  const makeClip = (attemptId) => ({
    ...fakeJob({ markdown: '# T\n\n正文', images: [] }),
    kind: 'clip', attemptId, imageMode: 'off',
  });
  const jobs = [makeClip('lane-c1'), makeClip('lane-c2')];
  const queued = new Set(jobs.map((job) => job.attemptId));
  let onBoth;
  const both = new Promise((resolve) => { onBoth = resolve; });
  const store = {
    async list() { return jobs.filter((job) => queued.has(job.attemptId)); },
    async claim(attemptId) { order.push(`claim:${attemptId}`); },
    async heartbeat() {},
    async beginCreate() {},
    async recordDocument() {},
    async get() { return { status: 'succeeded' }; },
    async complete(attemptId) {
      order.push(`complete:${attemptId}`);
      queued.delete(attemptId);
      if (queued.size === 0) onBoth();
    },
    async fail(_id, _w, result) { throw new Error(`不得失败: ${JSON.stringify(result)}`); },
  };
  const lark = { async run() { return { ok: true, data: { document: { document_id: 'doc1', url: 'https://doc1' } } }; } };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await both;

  assert.deepEqual(order, ['claim:lane-c1', 'complete:lane-c1', 'claim:lane-c2', 'complete:lane-c2'], 'clip 通道串行');
});

// ——— {{@file}} 占位符（#79）：指令检出占位符且有 url 型 PDF 时，executor 在调 AI 前
// 下载字节作为附件传给 generateDigest；无 PDF / 下载失败 / 超 32 MB 静默降级纯文本 + 警告 ———

function digestFileSetup({ pdfSource = null, instruction = '结合附件总结 {{@file}}' } = {}) {
  const rig = digestSetup({ markdown: '# T\n\n正文', digest: { enabled: true, instruction }, pdfSource });
  const calls = { downloads: [], digest: null };
  const downloadPdf = async (url) => {
    calls.downloads.push(url);
    const buffer = Buffer.from('%PDF-1.7 digest-attachment');
    return { buffer, source: url, sizeBytes: buffer.length };
  };
  const generateDigest = async (args) => { calls.digest = args; return 'AI 要点'; };
  return { ...rig, calls, downloadPdf, generateDigest };
}

test('{{@file}}：有 url 型 PDF → 下载后作为附件传给 generateDigest，指令原样透传（剥除在 generateDigest 内）', async () => {
  const { store, lark, calls, downloadPdf, generateDigest } = digestFileSetup({
    pdfSource: { type: 'url', url: 'https://example.com/paper.pdf', name: 'paper.pdf' },
  });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG, downloadPdf }).kick();
  await store.settled;

  assert.deepEqual(calls.downloads, ['https://example.com/paper.pdf']);
  assert.equal(calls.digest.instruction, '结合附件总结 {{@file}}', '占位符剥除在 generateDigest 内完成');
  assert.equal(calls.digest.pdf.filename, 'T.pdf', '附件名与云盘 PDF 同一命名规则（标题模板渲染结果）');
  assert.equal(Buffer.from(calls.digest.pdf.dataBase64, 'base64').toString(), '%PDF-1.7 digest-attachment');
  assert.deepEqual(store.completed.warnings, [], '附件随请求发出，无降级警告');
  const digestStage = store.completed.timeline.find((entry) => entry.name === 'digest');
  assert.match(digestStage.detail, /^已附 PDF（T\.pdf，[\d.]+ MB）$/, '任务日志正向标记附件');
});

test('{{@file}}：指令不含占位符时即使携带 pdfSource 也不下载、不带附件（回归）', async () => {
  const { store, lark, calls, downloadPdf, generateDigest } = digestFileSetup({
    pdfSource: { type: 'url', url: 'https://example.com/paper.pdf', name: 'paper.pdf' },
    instruction: '总结成三点',
  });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG, downloadPdf }).kick();
  await store.settled;

  assert.deepEqual(calls.downloads, [], '无占位符不下载 PDF');
  assert.equal(calls.digest.pdf, undefined, '无占位符不带附件');
  assert.deepEqual(store.completed.warnings, []);
});

test('{{@file}}：无可用 PDF → 纯文本摘要 + job 警告（不失败、不调下载）', async () => {
  const { store, lark, calls, downloadPdf, generateDigest } = digestFileSetup();
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG, downloadPdf }).kick();
  await store.settled;

  assert.ok(store.completed, 'job 不失败');
  assert.equal(store.failed, null);
  assert.deepEqual(calls.downloads, []);
  assert.equal(calls.digest.pdf, undefined, '无附件按纯文本摘要');
  assert.deepEqual(store.completed.warnings, ['摘要指令含 {{@file}} 但本次剪藏没有可用 PDF，已按纯文本生成摘要']);
});

test('{{@file}}：PDF 下载失败 → 纯文本摘要 + job 警告（不失败）', async () => {
  const rig = digestFileSetup({ pdfSource: { type: 'url', url: 'https://example.com/paper.pdf' } });
  const downloadPdf = async () => { throw Object.assign(new Error('PDF_HTTP_403'), { code: 'PDF_FETCH_FAILED', statusCode: 403 }); };
  new ClipExecutor({ store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} }, generateDigest: rig.generateDigest, getAiConfig: async () => AI_CONFIG, downloadPdf }).kick();
  await rig.store.settled;

  assert.ok(rig.store.completed, 'job 不失败');
  assert.equal(rig.calls.digest.pdf, undefined, '下载失败按纯文本摘要');
  assert.equal(rig.store.completed.warnings.length, 1);
  assert.match(rig.store.completed.warnings[0], /PDF 下载失败.*已按纯文本生成摘要/);
});

// ——— 下载成功率（#92）：定 IP 钉孔意味着重试总打同一个 CDN 边缘节点；瞬时网络错误
// 重试时按 attempt 轮转 A 记录换节点。摘要附件路径此前裸调 downloadPdf 无重试，
// 与 pdf job（3 次尝试）拉齐 ———

test('{{@file}}：附件下载撞瞬时网络错误自动重试（带递增 attempt 轮转节点），成功仍带附件（#92）', async () => {
  const rig = digestFileSetup({ pdfSource: { type: 'url', url: 'https://arxiv.org/pdf/2608.26263', name: 'a.pdf' } });
  let attempts = 0;
  const downloadPdf = async (url, options) => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    assert.equal(options?.attempt, 2, '重试带递增 attempt 供边缘节点轮转');
    return { buffer: Buffer.from('%PDF-1.7 retried'), source: url, sizeBytes: 16 };
  };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  new ClipExecutor({ store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} }, generateDigest: rig.generateDigest, getAiConfig: async () => AI_CONFIG, downloadPdf, sleep }).kick();
  await rig.store.settled;

  assert.equal(attempts, 2, 'ECONNRESET 后重试一次即成功');
  assert.deepEqual(sleeps, [1000], '首次退避约 1s');
  assert.equal(Buffer.from(rig.calls.digest.pdf.dataBase64, 'base64').toString(), '%PDF-1.7 retried', '重试成功带附件');
  assert.deepEqual(rig.store.completed.warnings, [], '重试成功无降级警告');
  assert.ok(rig.store.completed.timeline.some((entry) => entry.kind === 'retry' && entry.name === 'pdf_download'), 'timeline 记重试');
});

test('{{@file}}：附件下载连续 3 次瞬时错误才降级纯文本（重试预算与 pdf job 一致，#92）', async () => {
  const rig = digestFileSetup({ pdfSource: { type: 'url', url: 'https://example.com/p.pdf', name: 'p.pdf' } });
  let attempts = 0;
  const downloadPdf = async () => { attempts += 1; throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); };
  new ClipExecutor({ store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} }, generateDigest: rig.generateDigest, getAiConfig: async () => AI_CONFIG, downloadPdf, sleep: async () => {} }).kick();
  await rig.store.settled;

  assert.equal(attempts, 3, '共 3 次尝试后才放弃');
  assert.equal(rig.calls.digest.pdf, undefined, '预算耗尽降级纯文本');
  assert.equal(rig.store.completed.warnings.length, 1);
  assert.match(rig.store.completed.warnings[0], /PDF 下载失败.*已按纯文本生成摘要/);
});

test('pdf job：瞬时重试按递增 attempt 调 downloadPdf（供边缘节点轮转，#92）', async () => {
  const store = pdfFakeStore({ ...PDF_JOB, attemptId: 'pdf-rotate' });
  const seen = [];
  const downloadPdf = async (url, options) => {
    seen.push(options?.attempt ?? 0);
    if (seen.length < 3) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return { buffer: Buffer.from('%PDF-'), source: url, sizeBytes: 5 };
  };
  const lark = { async uploadDriveFile() { return { fileToken: 'f', url: 'https://u' }; } };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} }, downloadPdf, sleep: async () => {} }).kick();
  await store.settled;

  assert.deepEqual(seen, [1, 2, 3], '3 次尝试带递增 attempt');
  assert.equal(store.completed?.kind, 'pdf', '重试后成功');
});

// ——— PDF 引用补插（#93）：#91 并行后 pdf 常先于 clip 建档完成，pdf 侧按「clip 未建好」
// 跳过；clip 建档完成后反向补插，与 pdf 侧共用 mark-before-insert 幂等（不双插）———

// clip 侧补插 rig：clip 正常建档；store.get 的 pdf 分支与 markPdfRefInserted 可脚本化
function backfillSetup({ pdfJob = null, clipOverrides = {} } = {}) {
  const rig = digestSetup({ markdown: '# T\n\n正文' });
  Object.assign(rig.store, clipOverrides);
  const marks = [];
  const inserted = [];
  rig.store.get = async (_id, kind) => (kind === 'pdf' ? pdfJob : { status: 'succeeded' });
  rig.store.markPdfRefInserted = async (attemptId, insertedFlag = true) => {
    marks.push({ attemptId, inserted: insertedFlag });
    return { claimed: insertedFlag === true && !rig.store._refInserted };
  };
  rig.lark.insertDocFileReference = async (args) => { rig.store._refInserted = true; inserted.push(args); };
  return { ...rig, marks, inserted };
}
const PDF_DONE = {
  status: 'succeeded', title: 'T', pdfSource: { type: 'url', url: 'https://arxiv.org/pdf/2608.26263', name: '2608.26263.pdf' },
  document: { fileToken: 'ft-1', url: 'https://u/f' },
};

test('PDF 引用补插（#93）：clip 建档完成时 pdf 已先行成功 → clip 侧插入文档开头引用块', async () => {
  const { store, lark, marks, inserted } = backfillSetup({ pdfJob: PDF_DONE });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;

  assert.deepEqual(inserted, [{ documentId: 'doc1', fileToken: 'ft-1', fileUrl: 'https://u/f', name: 'T.pdf' }], '以 pdf 产物 + 同一命名规则补插');
  assert.deepEqual(marks, [{ attemptId: 'attempt-pipe', inserted: true }], '先置位再插入');
  assert.deepEqual(store.completed.warnings, []);
  assert.ok(store.completed.timeline.some((entry) => entry.kind === 'stage' && entry.name === 'pdf_ref_insert'), 'timeline 记补插阶段');
});

test('PDF 引用补插（#93）：pdf 未成功/不存在/已插过 → 不插不警告（静默）', async () => {
  const cases = [
    ['pdf 仍在跑', { ...PDF_DONE, status: 'running', document: null }],
    ['pdf 失败', { ...PDF_DONE, status: 'failed', document: null }],
    ['无 pdf job（未开 PDF 存云盘）', null],
  ];
  for (const [label, pdfJob] of cases) {
    const { store, lark, marks, inserted } = backfillSetup({ pdfJob });
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
    await store.settled;
    assert.equal(inserted.length, 0, `${label}：不插入`);
    assert.equal(marks.length, 0, `${label}：不置位`);
    assert.deepEqual(store.completed.warnings, [], `${label}：不警告`);
  }
});

test('PDF 引用补插（#93）：插入失败 → 清标记 + clip 警告，job 不失败', async () => {
  const { store, lark, marks } = backfillSetup({ pdfJob: PDF_DONE });
  lark.insertDocFileReference = async () => { throw new Error('docx api 999'); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;

  assert.ok(store.completed, '插入失败不 fail job');
  assert.equal(store.completed.warnings.length, 1);
  assert.match(store.completed.warnings[0], /PDF 云盘引用插入失败/);
  assert.deepEqual(marks, [
    { attemptId: 'attempt-pipe', inserted: true },
    { attemptId: 'attempt-pipe', inserted: false },
  ], '先置位、失败后清标记（重试可补插）');
});

test('PDF 引用补插（#93）：与 pdf 侧竞态——mark 返回 claimed=false → 不双插', async () => {
  const { store, lark, inserted } = backfillSetup({ pdfJob: PDF_DONE });
  store.markPdfRefInserted = async (attemptId, insertedFlag = true) => ({ claimed: false });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;

  assert.equal(inserted.length, 0, '置位被抢先则不插入');
  assert.deepEqual(store.completed.warnings, [], '竞态跳过不记警告');
});

// ——— 摘要附件字节共享（#94）：url 型 pdf job 与 {{@file}} 摘要附件下载的是同一 URL，
// pdf 通道下载成功后经 executor 内存表共享给摘要，免第二次下载；共享被拒/超时回退
// 现有路径（自己下载带 #92 重试；401 语义直接进 #80 staging 等待）———

// 双 job（clip+pdf 同 attemptId）rig：两条通道并行消费，pdf 状态机可脚本化
function shareSetup() {
  const attemptId = 'share-1';
  const clipJob = {
    ...fakeJob({ markdown: '# T\n\n正文', images: [] }),
    kind: 'clip', attemptId, imageMode: 'off',
    digest: { enabled: true, instruction: '结合附件总结 {{@file}}', mode: 'inline' },
    pdfSource: { type: 'url', url: 'https://arxiv.org/pdf/2608.26263', name: '2608.26263.pdf' },
    primaryAttachmentId: 'main-pdf',
  };
  const pdfJob = {
    kind: 'pdf', attemptId, title: 'T', sourceUrl: clipJob.snapshot.sourceUrl,
    status: 'queued', attachmentId: 'main-pdf', pdfSource: { ...clipJob.pdfSource }, document: null,
  };
  const jobs = { clip: clipJob, pdf: pdfJob };
  const workers = {};
  const queued = new Set(['clip', 'pdf']);
  let onClip;
  let onBoth;
  const clipSettled = new Promise((resolve) => { onClip = resolve; });
  const bothSettled = new Promise((resolve) => { onBoth = resolve; });
  const store = {
    completed: {},
    failed: {},
    clipSettled,
    bothSettled,
    async list() { return [clipJob, pdfJob].filter((job) => queued.has(job.kind)); },
    async claim(_id, workerId, kind = 'clip') { workers[kind] = workerId; if (kind === 'pdf') pdfJob.status = 'running'; },
    async heartbeat() {},
    async beginCreate() {},
    async recordDocument() {},
    async recordDigest() {},
    async get(_id, kind, attachmentId) {
      if (kind === 'pdf') {
        assert.equal(attachmentId, 'main-pdf', '摘要始终按 primaryAttachmentId 读取 PDF job');
        return { ...pdfJob, workerId: workers.pdf };
      }
      return { ...clipJob, status: queued.has('clip') ? 'running' : 'succeeded', document: queued.has('clip') ? null : { documentId: 'doc1', url: 'https://doc1' } };
    },
    async requestBytes(_id, attachmentId) { assert.equal(attachmentId, 'main-pdf'); if (pdfJob.status !== 'awaiting_bytes') pdfJob.status = 'awaiting_bytes'; },
    async awaitBytes() { pdfJob.status = 'awaiting_bytes'; queued.delete('pdf'); },
    async markPdfRefInserted() { return { claimed: false }; },
    async complete(_id, _w, result, kind = 'clip') {
      store.completed[kind] = result;
      queued.delete(kind);
      if (kind === 'pdf') { pdfJob.status = 'succeeded'; pdfJob.document = result.document; }
      if (kind === 'clip') onClip();
      if (queued.size === 0) onBoth();
    },
    async fail(_id, _w, result, kind = 'clip') {
      store.failed[kind] = result;
      queued.delete(kind);
      if (kind === 'pdf') pdfJob.status = 'failed';
      if (kind === 'clip') onClip();
      if (queued.size === 0) onBoth();
    },
  };
  const lark = {
    async run() { return { ok: true, data: { document: { document_id: 'doc1', url: 'https://doc1' } } }; },
    async uploadDriveFile() { return { fileToken: 'ft-1', url: 'https://u/f' }; },
    async insertDocFileReference() {},
  };
  const digestCalls = [];
  const generateDigest = async (args) => { digestCalls.push(args); return 'AI 要点'; };
  return { store, lark, digestCalls, generateDigest, pdfJob };
}

test('字节共享（#94）：pdf 通道下载成功后摘要零额外下载，直接复用共享字节', async () => {
  const { store, lark, digestCalls, generateDigest } = shareSetup();
  let downloads = 0;
  const downloadPdf = async (url) => { downloads += 1; return { buffer: Buffer.from('%PDF-1.7 shared'), source: url, sizeBytes: 15 }; };
  const executor = new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf, generateDigest, getAiConfig: async () => AI_CONFIG });
  executor.kick();
  await store.bothSettled;
  await new Promise((resolve) => setImmediate(resolve)); // 让 #execute 的 finally（共享表清理）跑完

  assert.equal(downloads, 1, '全文只下载一次（pdf 通道）');
  assert.equal(Buffer.from(digestCalls[0].pdf.dataBase64, 'base64').toString(), '%PDF-1.7 shared', '摘要附件即共享字节');
  assert.deepEqual(store.completed.clip.warnings, []);
  assert.ok(store.completed.clip.timeline.some((entry) => entry.name === 'pdf_share'), 'timeline 记共享来源');
  assert.equal(executor.pdfShares.size, 0, 'clip 终态后共享条目已清理');
});

test('字节共享（#94）：pdf 下载业务失败（非瞬时）→ 共享被拒，摘要回退自己下载', async () => {
  const { store, lark, digestCalls, generateDigest } = shareSetup();
  let downloads = 0;
  const downloadPdf = async (url) => {
    downloads += 1;
    if (downloads === 1) throw Object.assign(new Error('PDF_HTTP_500'), { code: 'PDF_FETCH_FAILED', statusCode: 500 });
    return { buffer: Buffer.from('%PDF-1.7 self'), source: url, sizeBytes: 13 };
  };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.bothSettled;

  assert.equal(downloads, 2, 'pdf 通道失败后摘要自己下载一次');
  assert.equal(Buffer.from(digestCalls[0].pdf.dataBase64, 'base64').toString(), '%PDF-1.7 self');
  assert.deepEqual(store.completed.clip.warnings, [], '摘要拿到附件，无降级警告');
  assert.ok(store.failed.pdf, 'pdf job 自身仍按失败收尾');
});

test('字节共享（#94）：共享等待超时（pdf 通道卡死）→ 摘要自己下载', async () => {
  const { store, lark, digestCalls, generateDigest } = shareSetup();
  let downloads = 0;
  const downloadPdf = async (url) => {
    downloads += 1;
    if (downloads === 1) return new Promise(() => {}); // pdf 通道永久挂起
    return { buffer: Buffer.from('%PDF-1.7 fallback'), source: url, sizeBytes: 17 };
  };
  // pdfShareWaitMs: 0 = 共享等待预算即刻耗尽（超时臂是独立 unref 定时器，不走注入 sleep）
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf, generateDigest, getAiConfig: async () => AI_CONFIG, pdfShareWaitMs: 0 }).kick();
  await store.clipSettled;

  assert.equal(downloads, 2, '超时后摘要自己下载');
  assert.equal(Buffer.from(digestCalls[0].pdf.dataBase64, 'base64').toString(), '%PDF-1.7 fallback');
  assert.deepEqual(store.completed.clip.warnings, []);
});

test('字节共享（#94）：pdf 撞 401 转 awaiting_bytes → 共享以凭据语义拒绝，摘要直接进 #80 staging 路径（不重复撞 401）', async () => {
  await withStaging(async (staging) => {
    const { store, lark, digestCalls, generateDigest, pdfJob } = shareSetup();
    let downloads = 0;
    const downloadPdf = async () => { downloads += 1; throw Object.assign(new Error('PDF_HTTP_401'), { code: 'PDF_FETCH_FAILED', statusCode: 401 }); };
    const declared = {
      type: 'bytes', url: pdfJob.pdfSource.url, name: pdfJob.pdfSource.name,
      sizeBytes: STAGED_PDF.length, totalChunks: 1, sha256: STAGED_SHA256,
    };
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      // 扩展喂齐 + server 整验通过 → markBytesReady
      await staging.putChunk('share-1', 0, STAGED_PDF);
      pdfJob.status = 'queued';
      pdfJob.pdfSource = declared;
    };
    new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, downloadPdf, generateDigest, getAiConfig: async () => AI_CONFIG, staging, sleep }).kick();
    await store.clipSettled;

    assert.equal(downloads, 1, '摘要不重复撞 401（只有 pdf 通道那一次）');
    assert.equal(Buffer.from(digestCalls[0].pdf.dataBase64, 'base64').toString(), STAGED_PDF.toString(), '附件来自 staging 字节');
    assert.deepEqual(store.completed.clip.warnings, []);
  });
});

test('{{@file}}：PDF 超过 32 MB 附件上限 → 去文件按纯文本摘要 + job 警告（不失败）', async () => {
  const rig = digestFileSetup({ pdfSource: { type: 'url', url: 'https://example.com/big.pdf' } });
  const downloadPdf = async (url) => ({ buffer: Buffer.alloc(AI_FILE_MAX_BYTES + 1, 0x25), source: url, sizeBytes: AI_FILE_MAX_BYTES + 1 });
  new ClipExecutor({ store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} }, generateDigest: rig.generateDigest, getAiConfig: async () => AI_CONFIG, downloadPdf }).kick();
  await rig.store.settled;

  assert.ok(rig.store.completed, 'job 不失败');
  assert.equal(rig.calls.digest.pdf, undefined, '超限去附件');
  assert.deepEqual(rig.store.completed.warnings, ['PDF 超过 AI 附件上限（32 MB），已按纯文本生成摘要']);
});

// ——— {{@file}} 凭据回退（#80）：digest 自行下载撞 401/403 → 把排队中的 url 型 pdf job 转
// awaiting_bytes，有界轮询等扩展喂齐 staging（server 整验通过 → markBytesReady 回 queued），
// 复用同一份字节作为 AI 附件（只读不 discard，云盘上传仍由 pdf job 消费 staging）———

const STAGED_PDF = Buffer.from('%PDF-1.7 staged-via-credentials');
const STAGED_SHA256 = createHash('sha256').update(STAGED_PDF).digest('hex');

// 带状态机 pdf job 的假 store：pdfJob 由测试脚本在推进（sleep 注入点翻状态）；
// heartbeat/requestBytes 是 #80 新增的 store 依赖
function digestStagingSetup({ pdfJobStatus = 'queued' } = {}) {
  const job = fakeJob({ markdown: '# T\n\n正文', images: [] });
  job.imageMode = 'off';
  job.digest = { enabled: true, instruction: '结合附件总结 {{@file}}', mode: 'inline' };
  job.pdfSource = { type: 'url', url: 'https://example.com/paywalled.pdf', name: 'paywalled.pdf' };
  let drained = false;
  let onSettled;
  const settled = new Promise((resolve) => { onSettled = resolve; });
  const store = {
    completed: null,
    failed: null,
    settled,
    pdfJob: { kind: 'pdf', attemptId: job.attemptId, status: pdfJobStatus, pdfSource: { ...job.pdfSource } },
    heartbeats: 0,
    requestedBytes: 0,
    async list() { return drained ? [] : [job]; },
    async claim() {},
    async beginCreate() {},
    async recordDocument() {},
    async recordDigest() {},
    async heartbeat() { store.heartbeats += 1; },
    async requestBytes() {
      store.requestedBytes += 1;
      if (store.pdfJob.status === 'awaiting_bytes') return;
      if (store.pdfJob.status !== 'queued' || store.pdfJob.pdfSource?.type !== 'url') {
        throw new Error(`Cannot request bytes for pdf job in ${store.pdfJob.status} state`);
      }
      store.pdfJob.status = 'awaiting_bytes';
    },
    async get(_id, kind) { return kind === 'pdf' ? { ...store.pdfJob } : { status: 'succeeded' }; },
    async complete(_id, _worker, result) { store.completed = result; drained = true; onSettled(); },
    async fail(_id, _worker, result) { store.failed = result; drained = true; onSettled(); },
  };
  const lark = {
    async run() { return { ok: true, data: { document: { document_id: 'doc1', url: 'https://doc1' } } }; },
  };
  const downloadPdf = async () => {
    throw Object.assign(new Error('PDF_HTTP_401'), { code: 'PDF_FETCH_FAILED', statusCode: 401 });
  };
  const digestCalls = [];
  const generateDigest = async (args) => { digestCalls.push(args); return 'AI 要点'; };
  return { store, lark, downloadPdf, generateDigest, digestCalls, job };
}

async function withStaging(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-digest-staging-'));
  try {
    await run(new PdfChunkStaging({ dir: path.join(directory, 'staging') }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('{{@file}} 凭据回退（#91 并行）：pdf job 正在 running（自身下载也会撞 401 转 awaiting_bytes）→ 不立即降级，等喂齐后复用字节', async () => {
  await withStaging(async (staging) => {
    const rig = digestStagingSetup({ pdfJobStatus: 'running' });
    const declared = {
      type: 'bytes', url: 'https://example.com/paywalled.pdf', name: 'paywalled.pdf',
      sizeBytes: STAGED_PDF.length, totalChunks: 1, sha256: STAGED_SHA256,
    };
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      // pdf 通道并行下载撞 401 → 自身转 awaiting_bytes
      if (polls === 1) rig.store.pdfJob = { ...rig.store.pdfJob, status: 'awaiting_bytes' };
      if (polls === 2) {
        // 扩展喂齐 + server 整验通过 → markBytesReady
        await staging.putChunk(rig.job.attemptId, 0, STAGED_PDF);
        rig.store.pdfJob = { ...rig.store.pdfJob, status: 'queued', pdfSource: declared };
      }
    };
    new ClipExecutor({
      store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} },
      downloadPdf: rig.downloadPdf, generateDigest: rig.generateDigest,
      getAiConfig: async () => AI_CONFIG, staging, sleep, pdfShareWaitMs: 0,
    }).kick();
    await rig.store.settled;

    assert.equal(rig.store.requestedBytes, 1, '仍先尝试 requestBytes（running 被拒）');
    assert.equal(rig.digestCalls.length, 1);
    assert.ok(rig.digestCalls[0].pdf, '等到字节后带附件，不降级纯文本');
    assert.deepEqual(rig.store.completed.warnings, []);
  });
});

test('{{@file}} 凭据回退：401 后等 staging 整验通过，复用同一份字节作附件；clip 只读不消费 staging', async () => {
  await withStaging(async (staging, directory) => {
    const rig = digestStagingSetup();
    const declared = {
      type: 'bytes', url: 'https://example.com/paywalled.pdf', name: 'paywalled.pdf',
      sizeBytes: STAGED_PDF.length, totalChunks: 1, sha256: STAGED_SHA256,
    };
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 2) {
        // 扩展喂齐 + server 整验通过 → markBytesReady：pdf job 回 queued（bytes 声明粘滞）
        await staging.putChunk(rig.job.attemptId, 0, STAGED_PDF);
        rig.store.pdfJob = { ...rig.store.pdfJob, status: 'queued', pdfSource: declared };
      }
    };
    new ClipExecutor({
      store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} },
      downloadPdf: rig.downloadPdf, generateDigest: rig.generateDigest,
      getAiConfig: async () => AI_CONFIG, staging, sleep, pdfShareWaitMs: 0,
    }).kick();
    await rig.store.settled;

    assert.equal(rig.store.requestedBytes, 1, 'clip 侧触发 pdf job 转 awaiting_bytes');
    assert.ok(rig.store.heartbeats >= 1, '等待期间 heartbeat 保 lease');
    assert.equal(rig.digestCalls.length, 1);
    assert.equal(Buffer.from(rig.digestCalls[0].pdf.dataBase64, 'base64').toString(), STAGED_PDF.toString(), '附件即 staging 同一份字节');
    assert.equal(rig.digestCalls[0].pdf.filename, 'T.pdf');
    assert.deepEqual(rig.store.completed.warnings, [], '整验通过无降级警告');
    assert.equal(rig.store.pdfJob.status, 'queued', 'clip 不消费 pdf job（云盘上传仍由它执行）');
    const leftovers = (await readdir(path.join(directory, 'staging'))).filter((entry) => entry.startsWith(rig.job.attemptId));
    assert.ok(leftovers.includes(`${rig.job.attemptId}.part`), 'clip 只读 staging，discard 留给 pdf job 收尾');
  });
});

test('{{@file}} 凭据回退：等待超时 → 纯文本摘要 + 超时警告，job 不失败', async () => {
  await withStaging(async (staging) => {
    const rig = digestStagingSetup();
    new ClipExecutor({
      store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} },
      downloadPdf: rig.downloadPdf, generateDigest: rig.generateDigest,
      getAiConfig: async () => AI_CONFIG, staging, sleep: async () => {}, digestPdfWaitMs: 3_000, pdfShareWaitMs: 0,
    }).kick();
    await rig.store.settled;

    assert.ok(rig.store.completed, 'job 不失败');
    assert.equal(rig.digestCalls[0].pdf, undefined, '超时去附件');
    assert.deepEqual(rig.store.completed.warnings, ['等待 PDF 字节回传超时，已按纯文本生成摘要']);
    assert.equal(rig.store.pdfJob.status, 'awaiting_bytes', '超时后 pdf job 维持 awaiting（扩展迟喂仍走原流程）');
  });
});

test('{{@file}} 凭据回退：等待期间 heartbeat 异常 → 降级纯文本摘要 + 警告，异常不逃逸成 job 失败', async () => {
  await withStaging(async (staging) => {
    const rig = digestStagingSetup();
    rig.store.heartbeat = async () => { throw new Error('lease lost'); };
    new ClipExecutor({
      store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} },
      downloadPdf: rig.downloadPdf, generateDigest: rig.generateDigest,
      getAiConfig: async () => AI_CONFIG, staging, sleep: async () => {}, digestPdfWaitMs: 3_000, pdfShareWaitMs: 0,
    }).kick();
    await rig.store.settled;

    assert.ok(rig.store.completed, 'job 不失败');
    assert.equal(rig.store.failed, null);
    assert.equal(rig.digestCalls[0].pdf, undefined, '降级去附件');
    assert.deepEqual(rig.store.completed.warnings, ['等待 PDF 字节期间任务租约异常，已按纯文本生成摘要']);
  });
});

test('{{@file}} 凭据回退：等待期间 pdf job 终态（cancelled）→ 不再等，纯文本摘要 + 警告', async () => {
  await withStaging(async (staging) => {
    const rig = digestStagingSetup();
    const sleep = async () => { rig.store.pdfJob = { ...rig.store.pdfJob, status: 'cancelled' }; };
    new ClipExecutor({
      store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} },
      downloadPdf: rig.downloadPdf, generateDigest: rig.generateDigest,
      getAiConfig: async () => AI_CONFIG, staging, sleep, pdfShareWaitMs: 0,
    }).kick();
    await rig.store.settled;

    assert.ok(rig.store.completed, 'job 不失败');
    assert.equal(rig.digestCalls[0].pdf, undefined);
    assert.deepEqual(rig.store.completed.warnings, ['PDF 任务已结束（cancelled），无法取得 PDF 字节，已按纯文本生成摘要']);
  });
});

test('{{@file}} 凭据回退：pdf job 已是终态（failed）→ requestBytes 拒绝，立即降级不等待', async () => {
  await withStaging(async (staging) => {
    const rig = digestStagingSetup({ pdfJobStatus: 'failed' });
    let sleeps = 0;
    new ClipExecutor({
      store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} },
      downloadPdf: rig.downloadPdf, generateDigest: rig.generateDigest,
      getAiConfig: async () => AI_CONFIG, staging, sleep: async () => { sleeps += 1; },
    }).kick();
    await rig.store.settled;

    assert.equal(rig.store.requestedBytes, 1, '尝试过触发');
    assert.equal(sleeps, 0, '终态不进入轮询等待');
    assert.equal(rig.digestCalls[0].pdf, undefined);
    assert.deepEqual(rig.store.completed.warnings, ['PDF 下载需要登录凭据，但 PDF 任务当前状态无法接收字节回传，已按纯文本生成摘要']);
  });
});

test('{{@file}} 凭据回退（#99 续竞态）：凭据回传快于 clip 建档——pdf 已 succeeded，staging 字节仍读作附件，读完顺手清理', async () => {
  await withStaging(async (staging, directory) => {
    const rig = digestStagingSetup({ pdfJobStatus: 'succeeded' });
    // pdf 通道已凭扩展回传字节完成上传：bytes 声明粘滞在 job 上，staging 被 pdf 收尾保留
    const declared = {
      type: 'bytes', url: 'https://example.com/paywalled.pdf', name: 'paywalled.pdf',
      sizeBytes: STAGED_PDF.length, totalChunks: 1, sha256: STAGED_SHA256,
    };
    rig.store.pdfJob = { ...rig.store.pdfJob, status: 'succeeded', pdfSource: declared };
    await staging.putChunk(rig.job.attemptId, 0, STAGED_PDF);
    let sleeps = 0;
    new ClipExecutor({
      store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} },
      downloadPdf: rig.downloadPdf, generateDigest: rig.generateDigest,
      getAiConfig: async () => AI_CONFIG, staging, sleep: async () => { sleeps += 1; }, pdfShareWaitMs: 0,
    }).kick();
    await rig.store.settled;

    assert.equal(sleeps, 0, 'succeeded 不进轮询，直接读 staging');
    assert.equal(rig.digestCalls.length, 1);
    assert.equal(Buffer.from(rig.digestCalls[0].pdf.dataBase64, 'base64').toString(), STAGED_PDF.toString(), '附件即 pdf 通道回传的同一份字节');
    assert.deepEqual(rig.store.completed.warnings, [], '不再误报「无法取得 PDF 字节」');
    const leftovers = (await readdir(path.join(directory, 'staging'))).filter((entry) => entry.startsWith(rig.job.attemptId));
    assert.deepEqual(leftovers, [], '字节已入云盘，读完顺手 discard');
  });
});

test('{{@file}} 凭据回退（#99 续竞态）：pdf 已 succeeded 但 staging 已清（clip 先终态）→ 维持降级警告', async () => {
  await withStaging(async (staging) => {
    const rig = digestStagingSetup({ pdfJobStatus: 'succeeded' });
    rig.store.pdfJob = {
      ...rig.store.pdfJob, status: 'succeeded',
      pdfSource: { type: 'bytes', url: 'https://example.com/paywalled.pdf', name: 'paywalled.pdf', sizeBytes: STAGED_PDF.length, totalChunks: 1, sha256: STAGED_SHA256 },
    };
    // 不写 staging——模拟 clip 先终态、pdf 收尾已正常清理的场景
    new ClipExecutor({
      store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} },
      downloadPdf: rig.downloadPdf, generateDigest: rig.generateDigest,
      getAiConfig: async () => AI_CONFIG, staging, sleep: async () => {}, pdfShareWaitMs: 0,
    }).kick();
    await rig.store.settled;

    assert.equal(rig.digestCalls[0].pdf, undefined);
    assert.deepEqual(rig.store.completed.warnings, ['PDF 任务已结束（succeeded），无法取得 PDF 字节，已按纯文本生成摘要']);
  });
});

test('{{@file}} 凭据回退：bytes 声明超 32 MB → 提前放弃（不等喂齐），纯文本摘要 + 超限警告', async () => {
  await withStaging(async (staging) => {
    const rig = digestStagingSetup();
    const sleep = async () => {
      rig.store.pdfJob = {
        ...rig.store.pdfJob,
        pdfSource: {
          type: 'bytes', url: 'https://example.com/paywalled.pdf', name: 'big.pdf',
          sizeBytes: AI_FILE_MAX_BYTES + 1, totalChunks: 9, sha256: 'f'.repeat(64),
        },
      };
    };
    new ClipExecutor({
      store: rig.store, lark: rig.lark, logger: { warn() {}, error() {} },
      downloadPdf: rig.downloadPdf, generateDigest: rig.generateDigest,
      getAiConfig: async () => AI_CONFIG, staging, sleep, pdfShareWaitMs: 0,
    }).kick();
    await rig.store.settled;

    assert.ok(rig.store.completed, 'job 不失败');
    assert.equal(rig.digestCalls[0].pdf, undefined);
    assert.deepEqual(rig.store.completed.warnings, ['PDF 超过 AI 附件上限（32 MB），已按纯文本生成摘要']);
  });
});

// ——— AI 摘要子文档模式（#98）：digest.mode 'subdoc'（缺省）把摘要挪到建档之后——
// 建父节点 → 建「Digest」子文档节点（占位行）→ digestDoc 落库 → 写正文（{{digest}} 渲染为
// 子文档链接，不再有 # Digest/# RAW content 两节）→ 顶部插 sub_page_list 块 → AI 流式 →
// 清空子文档重写。重跑靠 digestDoc/digestText 幂等；拿不到子文档（node 目标无 wiki token、
// 创建失败）退化内联摘要并记警告
function subdocSetup({
  markdown = '# T\n\n前文 {{digest}} 后文', digest = {}, digestText = null, digestDoc = null,
  document = null, destination = { kind: 'space', spaceId: 'space-1' }, failOn = null,
  nodeLookup = { node_token: 'node-created', space_id: 'space-x' },
  childNodes = [],
} = {}) {
  const job = fakeJob({ markdown, images: [] });
  job.imageMode = 'off';
  job.destination = destination;
  job.digest = { enabled: true, instruction: '总结', ...digest };
  if (digestText !== null) job.digestText = digestText;
  if (digestDoc) job.digestDoc = digestDoc;
  if (document) job.document = document;
  const events = [];
  const calls = [];
  const writes = [];
  const store = fakeStore(job);
  store.digestDocRecorded = null;
  store.recordDigestDoc = async (_id, _worker, recorded) => { events.push('record-digest-doc'); store.digestDocRecorded = recorded; };
  const lark = {
    calls,
    async run(args, options) {
      calls.push(args);
      if (failOn?.(args)) throw new Error('lark boom');
      const [head, sub] = args;
      if (head === 'wiki' && sub === '+node-create') {
        if (args.includes('--parent-node-token')) {
          events.push('create-digest');
          // 钉住真实应答形状（实证：lark-cli +node-create 返回扁平 node，不是 data.node 包裹）
          return { ok: true, data: { obj_token: 'doc-digest', node_token: 'node-digest', url: 'https://example.feishu.cn/wiki/node-digest' } };
        }
        events.push('create-parent');
        return { ok: true, data: { obj_token: 'doc-parent', node_token: 'node-parent', url: 'https://example.feishu.cn/wiki/node-parent' } };
      }
      if (head === 'wiki' && sub === '+node-list') {
        events.push('list-children');
        return { ok: true, data: { items: childNodes } };
      }
      if (head === 'docs' && sub === '+create') {
        events.push('create-doc');
        return { ok: true, data: { document: { document_id: 'doc-parent', url: 'https://example.feishu.cn/wiki/doc-parent' } } };
      }
      if (head === 'docs' && sub === '+update') {
        const doc = args[args.indexOf('--doc') + 1];
        const at = args.find((arg) => String(arg).startsWith('@'));
        const content = at ? await readFile(path.join(options.cwd, at.slice(1)), 'utf8') : null;
        events.push(`write:${doc}`);
        writes.push({ doc, content });
        return { ok: true, data: {} };
      }
      if (head === 'api') {
        const [, method, apiPath] = args;
        if (apiPath.includes('get_node')) {
          events.push('get-node');
          // 钉住真实 API 形状（#99 续排查实证：POST 或 obj_token 参数名在真实飞书 API 上是 404）
          const params = JSON.parse(args[args.indexOf('--params') + 1]);
          if (method !== 'GET' || !params.token || params.obj_token) throw new Error('get_node 形状错误（真实 API 会 404）');
          if (!nodeLookup) throw new Error('get_node 失败');
          return { ok: true, data: { node: nodeLookup } };
        }
        if (method === 'GET' && apiPath.endsWith('/blocks')) {
          // 子文档当前内容：页块下挂一个占位文本块
          return { ok: true, data: { items: [containerBlock('doc-digest', '', 1, ['ph']), textBlock('ph', 'doc-digest', 'AI 摘要生成中…')], has_more: false } };
        }
        if (method === 'GET' && apiPath.endsWith('/children')) {
          // 父文档顶层块（真实块结构实证）：首个 quote_container 是「来源」元信息块，
          // 子页面列表应插到它后面（index 1），不再插 index 0 制造断层
          return { ok: true, data: { items: [{ block_type: 34, quote_container: {} }, { block_type: 2, text: {} }] } };
        }
        if (method === 'DELETE') { events.push(`clear:${apiPath.match(/documents\/([^/]+)/)?.[1]}`); return { ok: true, data: {} }; }
        if (method === 'POST' && apiPath.includes('/children')) { events.push('sub-page-list'); return { ok: true, data: { children: [{ block_id: 'sp-1' }] } }; }
        return { ok: true, data: {} };
      }
      throw new Error(`unexpected lark call: ${args.join(' ')}`);
    },
  };
  const generateDigest = async () => { events.push('ai'); return 'AI 要点'; };
  return { store, lark, events, calls, writes, job, generateDigest };
}

test('AI 摘要子文档（#98）：space 目标完整时序——父文档秒建不等 AI，摘要落子文档', async () => {
  const { store, lark, events, writes, generateDigest } = subdocSetup();
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.deepEqual(events, [
    'create-parent', 'create-digest', 'record-digest-doc',
    'write:doc-digest', 'write:doc-parent', 'sub-page-list',
    'ai', 'clear:doc-digest', 'write:doc-digest',
  ], '建父节点 → 建子文档 → 落库 → 占位 → 正文 → 子页面列表 → AI → 清空重写');
  assert.deepEqual(store.digestDocRecorded, {
    documentId: 'doc-digest', nodeToken: 'node-digest', url: 'https://example.feishu.cn/wiki/node-digest',
  }, '子文档句柄落库（重跑幂等）');
  const parentWrite = writes.find((entry) => entry.doc === 'doc-parent');
  assert.match(parentWrite.content, /前文 \[Digest\]\(https:\/\/example\.feishu\.cn\/wiki\/node-digest\) 后文/, '{{digest}} 渲染为子文档链接');
  assert.doesNotMatch(parentWrite.content, /\{\{\s*digest\s*\}\}/);
  assert.doesNotMatch(parentWrite.content, /^# Digest$/m, 'subdoc 不再写默认 Digest 节');
  assert.doesNotMatch(parentWrite.content, /# RAW content/, 'subdoc 不再写 RAW content 节');
  assert.deepEqual(writes.filter((entry) => entry.doc === 'doc-digest').map((entry) => entry.content), ['AI 摘要生成中…', 'AI 要点'], '子文档先占位后正文');
  const subPageList = apiCalls(lark.calls, 'POST', '/children');
  assert.equal(subPageList.length, 1);
  assert.deepEqual(JSON.parse(subPageList[0][subPageList[0].indexOf('--data') + 1]), {
    index: 1, children: [{ block_type: 51, sub_page_list: { wiki_token: 'node-parent' } }],
  }, 'sub_page_list 紧随「来源」元信息引用容器（index 1），wiki_token=clip 文档节点 token');
  const clear = apiCalls(lark.calls, 'DELETE', 'batch_delete');
  assert.deepEqual(deleteBody(clear[0]), { start_index: 0, end_index: 1 }, '重写前清空子文档全部块');
  assert.equal(store.digestRecorded, 'AI 要点', '摘要文本照常缓存');
  assert.deepEqual(store.completed.warnings, []);
  assert.ok(store.completed.timeline.some((entry) => entry.kind === 'stage' && entry.name === 'digest_doc'), '子文档写入阶段计时');
});

test('AI 摘要子文档（#98）：digest.docTitle 决定子文档标题与父文档链接文本', async () => {
  const { store, lark, calls, writes, generateDigest } = subdocSetup({ digest: { docTitle: '本文要点' } });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  const createDigest = calls.find((args) => args[1] === '+node-create' && args.includes('--parent-node-token'));
  assert.equal(createDigest[createDigest.indexOf('--title') + 1], '本文要点', '子文档标题取 digest.docTitle');
  assert.match(writes.find((entry) => entry.doc === 'doc-parent').content, /\[本文要点\]\(https:\/\/example\.feishu\.cn\/wiki\/node-digest\)/, '链接文本同一标题');
});

test('AI 摘要子文档（#98）：document+digestDoc+digestText 齐全的重跑整段短路——零 lark 调用零 AI', async () => {
  const { store, lark, events } = subdocSetup({
    document: { documentId: 'doc-parent', url: 'https://example.feishu.cn/wiki/node-parent' },
    digestDoc: { documentId: 'doc-digest', nodeToken: 'node-digest', url: 'https://example.feishu.cn/wiki/node-digest' },
    digestText: '缓存摘要',
  });
  let ai = 0;
  const generateDigest = async () => { ai += 1; throw new Error('缓存命中不得调 AI'); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.equal(ai, 0);
  assert.deepEqual(events, [], '不重写父文档也不重写子文档');
  assert.deepEqual(store.completed.warnings, []);
});

test('AI 摘要子文档（#98）：摘要失败后的重跑复用已落库 digestDoc——不重建子文档，清空重写', async () => {
  const { store, lark, events, generateDigest } = subdocSetup({
    document: { documentId: 'doc-parent', url: 'https://example.feishu.cn/wiki/node-parent' },
    digestDoc: { documentId: 'doc-digest', nodeToken: 'node-digest', url: 'https://example.feishu.cn/wiki/node-digest' },
  });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.deepEqual(events, ['ai', 'clear:doc-digest', 'write:doc-digest'], '复用同一子文档，不重建档不重复落库');
  assert.equal(store.digestDocRecorded, null, '不再调 recordDigestDoc');
  assert.equal(store.digestRecorded, 'AI 要点');
  assert.deepEqual(store.completed.warnings, []);
});

test('AI 摘要子文档（#98）：digestDoc 未落库的重跑按标题找回既有子文档——不重建、AI 重跑写入', async () => {
  // 首次运行 recordDigestDoc 失败（子文档已在 wiki 上建好但句柄没落下）：重跑必须找回它，
  // 否则子文档永远停在占位行、AI 永不重调（违反幂等 spec）
  const { store, lark, events, writes, generateDigest } = subdocSetup({
    document: { documentId: 'doc-parent', url: 'https://example.feishu.cn/wiki/node-parent' },
    nodeLookup: { node_token: 'node-parent', space_id: 'space-1' },
    childNodes: [{ title: 'Digest', obj_type: 'docx', obj_token: 'doc-digest-old', node_token: 'node-digest-old' }],
  });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.ok(!events.includes('create-parent') && !events.includes('create-digest'), '找回路径不重建任何文档');
  assert.ok(events.includes('list-children'), '列出子节点按标题找回');
  assert.deepEqual(store.digestDocRecorded, {
    documentId: 'doc-digest-old', nodeToken: 'node-digest-old', url: 'https://example.feishu.cn/wiki/node-digest-old',
  }, '找回的句柄补落库');
  assert.deepEqual(events.slice(events.indexOf('ai')), ['ai', 'clear:doc-digest-old', 'write:doc-digest-old'], 'AI 重跑并清空重写找回的子文档');
  assert.deepEqual(store.completed.warnings, []);
});

test('AI 摘要子文档（#98）：找回不到子文档（被删/首次未建成）的重跑重建子文档', async () => {
  const { store, lark, events, generateDigest } = subdocSetup({
    document: { documentId: 'doc-parent', url: 'https://example.feishu.cn/wiki/node-parent' },
    nodeLookup: { node_token: 'node-parent', space_id: 'space-1' },
    childNodes: [],
  });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.ok(events.includes('list-children') && events.includes('create-digest'), '找回落空 → 重建子文档');
  assert.deepEqual(store.digestDocRecorded, {
    documentId: 'doc-digest', nodeToken: 'node-digest', url: 'https://example.feishu.cn/wiki/node-digest',
  }, '新子文档句柄落库');
  assert.ok(events.includes('ai'), 'AI 重跑');
});

test('AI 摘要子文档（#98）：AI 失败——子文档写入失败原因（与 job 警告同文案），job 部分成功', async () => {
  const { store, lark, writes } = subdocSetup();
  const generateDigest = async () => { throw Object.assign(new Error('invalid key'), { code: 'AI_AUTH_FAILED' }); };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.ok(store.completed, '摘要失败不 fail job');
  assert.equal(store.failed, null);
  assert.deepEqual(store.completed.warnings, ['AI 摘要生成失败：AI API 密钥无效或没有权限']);
  const digestWrites = writes.filter((entry) => entry.doc === 'doc-digest').map((entry) => entry.content);
  assert.equal(digestWrites.at(-1), 'AI 摘要生成失败：AI API 密钥无效或没有权限', '子文档留下与警告同文案的失败原因');
  assert.equal(store.digestRecorded, null, '失败不写缓存');
});

test('AI 摘要子文档（#98）：provider 悬空——子文档写明原因，不调 AI，job 仍成功', async () => {
  const { store, lark, writes } = subdocSetup({ digest: { provider: 'ghost' } });
  let ai = 0;
  const generateDigest = async () => { ai += 1; return 'x'; };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async (name) => (name === 'ghost' ? null : AI_CONFIG) }).kick();
  await store.settled;

  assert.equal(ai, 0, 'provider 缺失不调 AI');
  assert.deepEqual(store.completed.warnings, ['AI provider「ghost」不存在（可能已被删除），本次未生成摘要']);
  const digestWrites = writes.filter((entry) => entry.doc === 'doc-digest').map((entry) => entry.content);
  assert.equal(digestWrites.at(-1), 'AI provider「ghost」不存在（可能已被删除），本次未生成摘要');
});

test('AI 摘要子文档（#98）：node 目标——空建文档 + get_node 取 wiki 节点后挂子文档', async () => {
  const { store, lark, events, calls, generateDigest } = subdocSetup({ destination: { kind: 'node', nodeToken: 'node-1' } });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  const createDoc = calls.find((args) => args[1] === '+create');
  assert.ok(createDoc, 'node 目标走 docs +create');
  assert.ok(!createDoc.includes('--content'), '先建空文档（正文等 get_node 后 append）');
  assert.deepEqual(events, [
    'create-doc', 'get-node', 'create-digest', 'record-digest-doc',
    'write:doc-digest', 'write:doc-parent', 'sub-page-list',
    'ai', 'clear:doc-digest', 'write:doc-digest',
  ]);
  const createDigest = calls.find((args) => args[1] === '+node-create');
  assert.equal(createDigest[createDigest.indexOf('--parent-node-token') + 1], 'node-created', '子文档挂在 clip 文档的 wiki 节点下');
  assert.equal(createDigest[createDigest.indexOf('--space-id') + 1], 'space-x', 'spaceId 取自 get_node 应答');
  const subPageList = apiCalls(lark.calls, 'POST', '/children');
  assert.match(JSON.parse(subPageList[0][subPageList[0].indexOf('--data') + 1]).children[0].sub_page_list.wiki_token, /node-created/);
  assert.deepEqual(store.completed.warnings, []);
});

test('AI 摘要子文档（#98）：node 目标拿不到 wiki 节点 → 退化内联摘要 + 警告', async () => {
  const { store, lark, events, writes, generateDigest } = subdocSetup({ destination: { kind: 'node', nodeToken: 'node-1' }, nodeLookup: null });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.ok(store.completed, '退化不 fail job');
  assert.ok(!events.includes('create-digest'), '不建子文档');
  assert.ok(events.includes('ai'), '补跑内联摘要阶段');
  const parentWrite = writes.find((entry) => entry.doc === 'doc-parent');
  assert.match(parentWrite.content, /前文 AI 要点 后文/, '占位符原位替换为摘要文本');
  assert.match(store.completed.warnings.join('\n'), /回退为内联摘要/);
  assert.equal(store.digestRecorded, 'AI 要点', '内联摘要照常缓存');
});

test('AI 摘要子文档（#98）：sub_page_list 插入失败仅记警告，子文档与正文照常', async () => {
  const { store, lark, events, writes, generateDigest } = subdocSetup({
    failOn: (args) => args[0] === 'api' && args[1] === 'POST' && args[2].includes('/children'),
  });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig: async () => AI_CONFIG }).kick();
  await store.settled;

  assert.ok(store.completed, '插入失败不 fail job');
  assert.equal(store.completed.warnings.length, 1);
  assert.match(store.completed.warnings[0], /子页面列表/);
  assert.ok(events.includes('ai'), '摘要照常生成');
  assert.equal(writes.filter((entry) => entry.doc === 'doc-digest').at(-1).content, 'AI 要点');
});

test('AI 摘要子文档（#98）：进度条目 digest 阶段开始建 waiting、调 AI 前翻 thinking、阶段结束即删', async () => {
  const { store, lark } = subdocSetup();
  let executor;
  const seen = {};
  const getAiConfig = async () => {
    seen.atConfig = executor.digestProgressOf('attempt-pipe');
    return AI_CONFIG;
  };
  const generateDigest = async ({ onProgress }) => {
    assert.equal(typeof onProgress, 'function');
    seen.atAi = executor.digestProgressOf('attempt-pipe');
    onProgress({ phase: 'writing', tokens: 7 });
    return 'AI 要点';
  };
  executor = new ClipExecutor({ store, lark, logger: { warn() {}, error() {} }, generateDigest, getAiConfig });
  executor.kick();
  await store.settled;

  assert.deepEqual(seen.atConfig, { phase: 'waiting', tokens: 0 }, '阶段开始（取配置时）已是 waiting 条目');
  assert.deepEqual(seen.atAi, { phase: 'thinking', tokens: 0 }, '调 AI 前翻 thinking（与内联一致）');
  assert.equal(executor.digestProgressOf('attempt-pipe'), null, 'digest 阶段结束即删条目（后续图片阶段不误判 digesting）');
});
