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
  // 插入图片块后锚点顺延一位，删除区间跟着 +1
  assert.deepEqual(deleteBody(deletes[0]), { start_index: 4, end_index: 5 });
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
  // 失败图片留下的空图片块要清掉：锚点 p1 在下标 1，图片块插在下标 1，删除 [1,2)
  const deletes = apiCalls(lark.calls, 'DELETE', 'batch_delete').map(deleteBody);
  assert.ok(deletes.some((body) => body.start_index === 1 && body.end_index === 2), '应清掉失败图片的空块');
  // 失败的锚点最后用 str_replace 换成可读文案
  const fallback = lark.calls.find((args) => args[1] === '+update' && args.includes('str_replace') && args.includes('[[FEISHU_CLIP_IMAGE:1]]'));
  assert.ok(fallback, '失败锚点应走 str_replace 回退');
  assert.match(fallback.join(' '), /原图链接/);
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
