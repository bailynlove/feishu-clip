import assert from 'node:assert/strict';
import path from 'node:path';
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

test('includeImages：有浏览器字节的图片保留锚点供上传管线定位', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'protected', source: 'https://example.com/a.png', bytesBase64: 'AA==' }],
  }, 'attempt-1', { includeImages: true });
  assert.match(prepared.markdown, /\[\[FEISHU_CLIP_IMAGE:0\]\]/);
  assert.doesNotMatch(prepared.markdown, /原图链接/);
});

// 内联 URL 管线（#45，spike 结论见 docs/research/inline-image-url-import.md）：
// 无浏览器字节的公开图片直接写成 Markdown 图片语法，由飞书服务端下载成图片块，
// 不再走「Bridge 下载 + 逐图 4 次 API 调用」的上传管线
test('includeImages：无字节的公开图片内联为 Markdown 图片语法，不产生锚点', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [
      { label: 'pub[lic]', source: 'https://cdn.example.com/a.png' },
      { label: 'protected', source: 'https://example.com/b.png', bytesBase64: 'AA==' },
    ],
  }, 'attempt-1', { includeImages: true });
  assert.match(prepared.markdown, /!\[pub\\\[lic\\\]\]\(https:\/\/cdn\.example\.com\/a\.png\)/, '内联图片语法，label 里的方括号要转义');
  assert.doesNotMatch(prepared.markdown, /\[\[FEISHU_CLIP_IMAGE:0\]\]/, '内联图片不留锚点');
  assert.match(prepared.markdown, /\[\[FEISHU_CLIP_IMAGE:1\]\]/, '有字节的图片保留锚点');
  assert.equal(prepared.images[0].inline, true, '内联图片要打 inline 标记供 executor 跳过');
  assert.notEqual(prepared.images[1].inline, true);
});

test('includeImages：无字节且 URL 不安全的图片直接降级为文本，不进上传管线', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'blob图', source: 'blob:https://example.com/id' }],
  }, 'attempt-1', { includeImages: true });
  assert.match(prepared.markdown, /图片：blob图/);
  assert.doesNotMatch(prepared.markdown, /blob:https/);
  assert.doesNotMatch(prepared.markdown, /FEISHU_CLIP_IMAGE/);
  assert.notEqual(prepared.images[0].inline, true, 'URL 不安全不能内联');
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

function fakeJob({ markdown, images }) {
  return {
    attemptId: 'attempt-pipe',
    document: null,
    includeImages: true,
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

test('a failed image keeps a warning, cleans up the empty block and degrades to an iframe preview block', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [
      { label: 'a', bytesBase64: PNG_BYTES },
      { label: 'b', source: 'https://cdn.example.com/b.png', bytesBase64: PNG_BYTES },
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
  // 失败的锚点降级为 iframe 预览块（#49）：原图 URL 直出，不再 str_replace 文本
  const previews = apiCalls(lark.calls, 'POST', '/children').filter((args) => args.join(' ').includes('"block_type":26'));
  assert.equal(previews.length, 1, '失败图应降级为 iframe 预览块');
  assert.ok(previews[0].join(' ').includes(encodeURIComponent('https://cdn.example.com/b.png')));
  assert.match(store.completed.warnings[0], /链接预览块/);
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
  job.includeImages = false;
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

// 内联 URL 管线（#45）：无字节图片由飞书服务端下载，executor 不做任何逐图调用
test('内联图片不下载不上传，只有锚点图片走块管线', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [
      { label: 'inline', source: 'https://cdn.example.com/a.png' },
      { label: 'upload', bytesBase64: PNG_BYTES },
    ],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p1']),
    textBlock('p1', 'doc1', '[[FEISHU_CLIP_IMAGE:1]]'),
  ];
  const lark = fakeLark({ items });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 1, '只有锚点图片上传');
  assert.equal(apiCalls(lark.calls, 'POST', '/children').length, 1, '只有锚点图片建块');
  assert.ok(store.completed.timeline.some((entry) => entry.kind === 'image' && entry.name === 'image-1' && entry.detail === 'inline-url'), '内联图片在时间线里留痕');
});

test('全部是内联图片时不做 blocks 拉取和任何逐图调用', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'inline', source: 'https://cdn.example.com/a.png' }],
  });
  const store = fakeStore(job);
  const lark = fakeLark({ items: [] });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.deepEqual(store.completed.warnings, []);
  assert.equal(apiCalls(lark.calls, 'GET', '/blocks').length, 0, '没有锚点图片时不需要拉块列表');
  assert.equal(lark.calls.filter((args) => args[1] === '+media-upload').length, 0);
});

// 服务端下载失败（degrade_code=2108）：失败图在文档里无残留（spike 实测），
// 只能删档重建并把失败图转回锚点管线——最多重建一次
test('服务端下载失败的图片：删档重建并转入锚点管线', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', source: 'https://nonexistent.invalid/a.png' }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items });
  let createCount = 0;
  const baseRun = lark.run.bind(lark);
  lark.run = async (args, options) => {
    if (args[0] === 'docs' && args[1] === '+create') {
      createCount += 1;
      if (createCount === 1) {
        return {
          ok: true,
          data: {
            document: { document_id: 'doc1', url: 'https://doc1' },
            warnings: ['degrade_code=2108,msg=Image download failed. image URL: https://nonexistent.invalid/a.png. Verify that the image URL is accessible'],
          },
        };
      }
    }
    return baseRun(args, options);
  };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(createCount, 2, '首次创建带 degrade warning 后应重建一次');
  const deleted = lark.calls.find((args) => args[0] === 'wiki' && args[1] === '+node-delete');
  assert.ok(deleted && deleted.includes('doc1'), '重建前删掉旧文档');
  assert.ok(deleted.includes('--yes'), 'node-delete 是高危命令，要带 --yes');
  assert.equal(apiCalls(lark.calls, 'GET', '/blocks').length, 2, '重建后走锚点管线 + 预览降级各拉一次块列表');
  // nonexistent.invalid 必然 DNS 失败：Bridge 也下不到，降级为 iframe 预览块（#49）
  assert.equal(store.completed.warnings.length, 1);
  assert.match(store.completed.warnings[0], /图片 1/);
  assert.match(store.completed.warnings[0], /链接预览块/);
  const previews = apiCalls(lark.calls, 'POST', '/children').filter((args) => args.join(' ').includes('"block_type":26'));
  assert.equal(previews.length, 1, '失败锚点应降级为 iframe 预览块');
});

test('重建后仍 degrade 不再重试，直接按现状完成', async () => {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', source: 'https://nonexistent.invalid/a.png' }],
  });
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = fakeLark({ items });
  let createCount = 0;
  const baseRun = lark.run.bind(lark);
  lark.run = async (args, options) => {
    if (args[0] === 'docs' && args[1] === '+create') {
      createCount += 1;
      return {
        ok: true,
        data: {
          document: { document_id: 'doc1', url: 'https://doc1' },
          warnings: ['degrade_code=2108,msg=Image download failed. image URL: https://nonexistent.invalid/a.png, HTTP status: 404.'],
        },
      };
    }
    return baseRun(args, options);
  };
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(createCount, 2, '最多重建一次');
  assert.ok(store.completed, '仍应正常完成（失败图走锚点管线的自身回退）');
});

// 服务端整体超时（"server time out error"，network/timeout）：飞书导入时串行下载内联图，
// 单张挂死图（miro.medium.com 实测必现）即可打满 30s 服务端预算。空间两步法中空节点已建好，
// 无法靠 warnings 定位失败图——删档重建一次，全部内联图翻转回锚点上传管线绕开服务端下载
function spaceTimeoutJob() {
  const job = fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', source: 'https://nonexistent.invalid/a.png' }],
  });
  job.destination = { kind: 'space', spaceId: 'space-1' };
  return job;
}
function spaceTimeoutLark(items, { timeoutOnAppends = new Set([1]) } = {}) {
  const lark = fakeLark({ items });
  let appendCount = 0;
  const baseRun = lark.run.bind(lark);
  lark.appendCount = () => appendCount;
  lark.run = async (args, options) => {
    if (args[0] === 'wiki' && args[1] === '+node-create') {
      lark.calls.push(args);
      return { ok: true, data: { obj_token: 'doc1', url: 'https://doc1' } };
    }
    if (args[0] === 'docs' && args[1] === '+update' && args.includes('append')) {
      appendCount += 1;
      if (timeoutOnAppends.has(appendCount)) {
        throw Object.assign(new Error('API call failed: server time out error'), { code: 'network' });
      }
    }
    return baseRun(args, options);
  };
  return lark;
}

test('空间目标 append 服务端超时：删档重建，全部内联图转回锚点管线', async () => {
  const job = spaceTimeoutJob();
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = spaceTimeoutLark(items);
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(lark.appendCount(), 2, '首次 append 超时后应删档重建一次');
  const creates = lark.calls.filter((args) => args[0] === 'wiki' && args[1] === '+node-create');
  assert.equal(creates.length, 2, '重建要重新建空节点');
  const deleted = lark.calls.filter((args) => args[0] === 'wiki' && args[1] === '+node-delete');
  assert.equal(deleted.length, 1, '重建前删掉旧节点');
  assert.ok(store.completed, '重建后应正常完成');
  assert.equal(apiCalls(lark.calls, 'GET', '/blocks').length, 2, '重建后走锚点管线 + 预览降级各拉一次块列表');
  assert.equal(store.completed.warnings.length, 1, 'nonexistent.invalid 必然下载失败，降级为 iframe 预览块（#49）');
});

test('重建后 append 仍超时：不再重建，按失败落盘', async () => {
  const job = spaceTimeoutJob();
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = spaceTimeoutLark(items, { timeoutOnAppends: new Set([1, 2]) });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.equal(lark.appendCount(), 2, '最多重建一次');
  assert.ok(store.failed, '重建后仍超时应失败落盘');
  assert.match(store.failed.error, /server time out/);
});

// 图片失败降级为 iframe 预览块（#49）：原图 URL 直出为 block_type 26 预览块，
// 渲染在查看者浏览器里，绕开服务端/桥下载（Medium miro 图唯一可行路径）；
// 建块失败才退回 str_replace 可读文案。
// 测试借 degrade-2108 重建路径把图片翻进锚点管线（无字节的公开图默认走内联，不进图片阶段）
function degradeRebuildJob() {
  return fakeJob({
    markdown: '# T\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'a', source: 'https://nonexistent.invalid/a.png' }],
  });
}
function degradeRebuildLark(items, { failOn } = {}) {
  const lark = fakeLark({ items, failOn });
  let createCount = 0;
  const baseRun = lark.run.bind(lark);
  lark.run = async (args, options) => {
    if (args[0] === 'docs' && args[1] === '+create') {
      createCount += 1;
      if (createCount === 1) {
        return {
          ok: true,
          data: {
            document: { document_id: 'doc1', url: 'https://doc1' },
            warnings: ['degrade_code=2108,msg=Image download failed. image URL: https://nonexistent.invalid/a.png. Verify that the image URL is accessible'],
          },
        };
      }
    }
    return baseRun(args, options);
  };
  return lark;
}

test('图片下载失败且有公开 URL：降级为 iframe 预览块而非纯文本', async () => {
  const job = degradeRebuildJob();
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = degradeRebuildLark(items);
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  // 重建后 Bridge 下载 nonexistent.invalid 必然 DNS 失败，触发预览块降级
  const inserts = apiCalls(lark.calls, 'POST', '/children');
  assert.equal(inserts.length, 1, '应建 iframe 预览块');
  const body = JSON.parse(inserts[0][inserts[0].indexOf('--data') + 1]);
  assert.equal(body.children[0].block_type, 26);
  assert.equal(body.children[0].iframe.component.iframe_type, 99);
  assert.equal(body.children[0].iframe.component.url, encodeURIComponent('https://nonexistent.invalid/a.png'));
  assert.match(store.completed.warnings[0], /链接预览块/);
  assert.ok(!lark.calls.some((args) => args[1] === '+update' && args.includes('str_replace')), '预览块降级成功就不应再 str_replace 文本');
});

test('iframe 预览块建块失败：退回纯文本原图链接', async () => {
  const job = degradeRebuildJob();
  const store = fakeStore(job);
  const items = [
    containerBlock('doc1', '', 1, ['p0']),
    textBlock('p0', 'doc1', '[[FEISHU_CLIP_IMAGE:0]]'),
  ];
  const lark = degradeRebuildLark(items, { failOn: (args) => args[0] === 'api' && args[1] === 'POST' });
  new ClipExecutor({ store, lark, logger: { warn() {}, error() {} } }).kick();
  await store.settled;
  assert.ok(store.completed, '降级失败不应拖垮任务');
  assert.equal(store.completed.warnings.length, 1);
  assert.doesNotMatch(store.completed.warnings[0], /链接预览块/);
  assert.ok(lark.calls.some((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IMAGE:0]]')), '应退回 str_replace 文本兜底');
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
