// background.js 消息处理回归：桩 chrome.* + fetch，通过真实 onMessage 监听器驱动。
// job 恢复指针（activeAttempt）的生命周期：CLIP 时写入/覆盖，查询（GET_JOB）永远不清——
// 清除会让「保存完成后重开弹窗看不到成功态」（用户实测 bug）：
// 跨页打开弹窗一次（终态 job 被静默丢弃是对的）顺带把指针清了，回到原页面也无状态可恢复。
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

const PAGE = 'https://example.com/article';
const ATTEMPT = '49e3082e-38c2-43f1-9c30-405d28b09e8a';

const terminalJob = {
  attemptId: ATTEMPT,
  sourceUrl: PAGE,
  status: 'succeeded',
  warnings: [],
  document: { documentId: 'doc1', url: 'https://doc1' },
};

// chrome/fetch 桩必须在 import background.js 之前就位（模块顶层即用 chrome.storage）
const storage = { activeAttempt: ATTEMPT, credential: 'cred' };
const listeners = [];
let lastJobsBody = null; // CLIP/SAVE_PDF_TAB 转发给 bridge 的 POST /v1/jobs 请求体
let lastDriveListUrl = null; // LIST_DRIVE_FOLDERS 的请求 URL（#66）
let lastDriveValidateBody = null; // VALIDATE_DRIVE_FOLDER 的请求体（#66）
let stubSnapshotPdf = null; // 非 null 时 extractor 桩的快照带 pdf 识别结果（#65）
let detectPdfResult = { pdf: null }; // pdf-detect.js 桩的探测结果
let tabUrl = PAGE; // 当前标签页 URL 桩（#67 探测用例会换 URL）
let pdfTabProbeResult = null; // DETECT_PDF_TAB 探针（func 注入）返回值
let pdfTabProbeError = null; // 非 null 时探针注入失败（走 URL 后缀兜底）
// ——— 凭据回传（#68）FEED_PDF_BYTES 用例的桩状态 ———
const PDF_SOURCE_URL = 'https://pub.example.com/paywalled.pdf';
let pdfSourceServer = null; // 非 null 时源站 URL 返回流式 Response；{ body } 或 { failStatus }
let feedJob = null; // FEED 用例的 pdf job 视图（GET /v1/jobs/:id 返回）
let chunkBitmap = []; // pdf-chunks GET 返回的位图
let postedChunks = []; // 记录分块 POST 请求体
globalThis.chrome = {
  runtime: { id: 'ext-id', onMessage: { addListener: (fn) => listeners.push(fn) } },
  tabs: { query: async () => [{ id: 1, url: tabUrl }] },
  scripting: {
    executeScript: async ({ files, func } = {}) => {
      if (func) {
        if (pdfTabProbeError) throw pdfTabProbeError;
        return [{ result: pdfTabProbeResult }];
      }
      if (files?.[0] === 'pdf-detect.js') return [{ result: detectPdfResult }];
      return [{
        result: { title: '页面标题', sourceUrl: PAGE, capturedAt: '2026-09-02T00:00:00.000Z', markdown: '# 正文', images: [], ...(stubSnapshotPdf ? { pdf: stubSnapshotPdf } : {}) },
      }];
    },
  },
  storage: {
    local: {
      setAccessLevel() {},
      async get(keys) {
        const out = {};
        for (const key of keys) if (key in storage) out[key] = storage[key];
        return out;
      },
      async set(values) { Object.assign(storage, values); },
      async remove(keys) { for (const key of [].concat(keys)) delete storage[key]; },
    },
  },
};
globalThis.fetch = async (url, options) => {
  // 源站 PDF（#68 凭据抓取）：流式 Response，分段 enqueue 模拟真实流
  if (url === PDF_SOURCE_URL && pdfSourceServer) {
    if (pdfSourceServer.failStatus) return { ok: false, status: pdfSourceServer.failStatus, body: null };
    const bytes = pdfSourceServer.body;
    return new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 1000) controller.enqueue(bytes.subarray(offset, offset + 1000));
        controller.close();
      },
    }), { status: 200 });
  }
  // 分块通道端点（#68）
  if (url.includes('/pdf-chunks')) {
    if (options?.method === 'POST') {
      postedChunks.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, complete: false, received: chunkBitmap.length + postedChunks.length }) };
    }
    return { ok: true, json: async () => ({ ok: true, declared: feedJob?.pdfSource?.type === 'bytes', totalChunks: feedJob?.pdfSource?.totalChunks ?? null, bitmap: chunkBitmap }) };
  }
  if (url.endsWith('/v1/jobs') && options?.method === 'POST') lastJobsBody = JSON.parse(options.body);
  if (url.endsWith('/v1/drive/folders/validate')) lastDriveValidateBody = JSON.parse(options.body);
  else if (url.includes('/v1/drive/folders')) lastDriveListUrl = url;
  return {
    ok: true,
    json: async () => {
      if (feedJob && url.includes(`/v1/jobs/${feedJob.attemptId}`)) return { ok: true, jobs: [feedJob] };
      if (url.includes(`/v1/jobs/${ATTEMPT}`)) return { ok: true, job: terminalJob };
      if (url.endsWith('/v1/drive/folders/validate')) return { ok: true, folder: { folderToken: lastDriveValidateBody.folderToken ?? null, name: '论文' } };
      if (url.includes('/v1/drive/folders')) return { ok: true, folders: [{ folderToken: 'fld-a', name: '论文' }], hasMore: false, nextPageToken: null };
      return { ok: true, job: { attemptId: 'new-attempt' } };
    },
  };
};

await import('../src/extension/background.js');
const send = (message) => new Promise((resolve, reject) => {
  listeners[0](message, {}, (response) => (response?.ok ? resolve(response.result) : reject(Object.assign(new Error(response?.error?.message), response?.error))));
});

test('跨页查询终态 job：不返回 job、也不清恢复指针，回到原页面仍可看到成功态', async () => {
  storage.activeAttempt = ATTEMPT;
  const other = await send({ type: 'GET_JOB', attemptId: ATTEMPT, pageUrl: 'https://example.com/other' });
  assert.equal(other.job, null, '跨页面不展示旧 job 状态');
  assert.equal(storage.activeAttempt, ATTEMPT, '跨页查询不得清除恢复指针');
  // 回到原页面重开：指针还在 → 成功态可恢复
  const same = await send({ type: 'GET_JOB', attemptId: storage.activeAttempt, pageUrl: PAGE });
  assert.equal(same.job?.status, 'succeeded');
});

test('本页查询终态 job：返回 job 且不清指针，重复打开仍提示成功态', async () => {
  storage.activeAttempt = ATTEMPT;
  const first = await send({ type: 'GET_JOB', attemptId: ATTEMPT, pageUrl: PAGE });
  assert.equal(first.job?.status, 'succeeded');
  assert.equal(storage.activeAttempt, ATTEMPT, '终态回读也不得清除指针（恢复提示设计）');
  const second = await send({ type: 'GET_JOB', attemptId: ATTEMPT, pageUrl: PAGE });
  assert.equal(second.job?.status, 'succeeded', '重复打开仍能看到成功态');
});

// 图片写入模式（#53）：弹窗选定的三态模式随 CLIP 透传到 bridge 任务
test('CLIP 把三态图片写入模式透传给 bridge', async () => {
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, imageMode: 'download', includeImages: true, title: 'T', customBody: '' });
  assert.equal(lastJobsBody.imageMode, 'download');
  assert.equal(lastJobsBody.includeImages, true);
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, imageMode: 'off', includeImages: false, title: 'T', customBody: '' });
  assert.equal(lastJobsBody.imageMode, 'off');
  assert.equal(lastJobsBody.includeImages, false);
});

// ——— PDF 存云盘（#65）：CLIP 的 pdfSource 组装 + DETECT_PDF 探测 + 重试复用 attemptId ———

const PDF_URL = 'https://arxiv.org/pdf/2401.00001';

test('CLIP 带 pdfEnabled：pdfSource 以快照识别结果为准、探测结果兜底，随任务上报 bridge', async () => {
  try {
    // 快照无 pdf：用弹窗传入的探测结果兜底
    await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: true, pdfSource: { url: PDF_URL, name: '2401.00001.pdf', sizeBytes: 2048 } });
    assert.deepEqual(lastJobsBody.pdfSource, { type: 'url', url: PDF_URL, name: '2401.00001.pdf', sizeBytes: 2048 });

    // 快照识别结果优先于探测兜底（保存时重跑提取，更新鲜）
    stubSnapshotPdf = { url: 'https://arxiv.org/pdf/2401.00002', name: '2401.00002.pdf' };
    await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: true, pdfSource: { url: PDF_URL } });
    assert.equal(lastJobsBody.pdfSource.url, 'https://arxiv.org/pdf/2401.00002', 'snapshot.pdf 优先于 message.pdfSource');

    // 非 http(s) 的识别结果丢弃
    stubSnapshotPdf = { url: 'javascript:alert(1)' };
    await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: true, pdfSource: { url: PDF_URL } });
    assert.equal(lastJobsBody.pdfSource, null, '快照识别不安全时不得回退到旧探测结果');
  } finally {
    stubSnapshotPdf = null;
  }
});

test('CLIP 未开 pdfEnabled：不上报 pdfSource', async () => {
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: false, pdfSource: { url: PDF_URL } });
  assert.equal(lastJobsBody.pdfSource, null);
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' } });
  assert.equal(lastJobsBody.pdfSource, null, '缺省等同关闭');
});

test('重试 PDF：弹窗复用同一 attemptId 重发 CLIP，原样透传给 bridge（bridge 侧幂等复位重排）', async () => {
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, attemptId: 'aaaaaaaa-1111-4111-8111-111111111111', pdfEnabled: true, pdfSource: { url: PDF_URL } });
  assert.equal(lastJobsBody.attemptId, 'aaaaaaaa-1111-4111-8111-111111111111');
});

test('DETECT_PDF：注入 pdf-detect.js 返回探测结果；未识别/异常按 null 处理', async () => {
  try {
    detectPdfResult = { pdf: { url: PDF_URL, name: '2401.00001.pdf', sizeBytes: 2048 } };
    const detected = await send({ type: 'DETECT_PDF' });
    assert.equal(detected.pdf.url, PDF_URL);
    assert.equal(detected.pdf.sizeBytes, 2048);

    detectPdfResult = { pdf: null };
    assert.equal((await send({ type: 'DETECT_PDF' })).pdf, null);
  } finally {
    detectPdfResult = { pdf: null };
  }
});

test('GET_JOB 兼容老 bridge 单 job 形态，并聚合新 bridge 的 jobs 数组', async () => {
  // 老形态（fetch 桩默认返回 { job }）：同页可恢复
  const legacy = await send({ type: 'GET_JOB', attemptId: ATTEMPT, pageUrl: PAGE });
  assert.equal(legacy.job?.status, 'succeeded');
  assert.deepEqual(legacy.jobs.map((job) => job.status), ['succeeded'], '老形态包成单元素数组');
});

// ——— Drive 目录选择器消息（#66）———

test('CLIP 透传 pdfFolderToken；缺省/非法值归一为 null（根目录）', async () => {
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: true, pdfSource: { url: PDF_URL }, pdfFolderToken: 'fld-papers' });
  assert.equal(lastJobsBody.pdfFolderToken, 'fld-papers');

  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: true, pdfSource: { url: PDF_URL } });
  assert.equal(lastJobsBody.pdfFolderToken, null, '缺省 = 云盘根目录');

  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: true, pdfSource: { url: PDF_URL }, pdfFolderToken: 42 });
  assert.equal(lastJobsBody.pdfFolderToken, null, '非字符串 token 不下发');
});

test('LIST_DRIVE_FOLDERS / VALIDATE_DRIVE_FOLDER 转发到 drive 端点族', async () => {
  lastDriveListUrl = null;
  const root = await send({ type: 'LIST_DRIVE_FOLDERS' });
  assert.ok(lastDriveListUrl.endsWith('/v1/drive/folders'), '省略 folderToken 列根层，不带查询参数');
  assert.equal(root.folders[0].folderToken, 'fld-a');

  await send({ type: 'LIST_DRIVE_FOLDERS', folderToken: 'fld-a', cursor: 'c2', limit: 20 });
  assert.ok(lastDriveListUrl.includes('parentFolderToken=fld-a'));
  assert.ok(lastDriveListUrl.includes('cursor=c2'));
  assert.ok(lastDriveListUrl.includes('limit=20'));

  const validated = await send({ type: 'VALIDATE_DRIVE_FOLDER', folderToken: 'fld-a' });
  assert.deepEqual(lastDriveValidateBody, { folderToken: 'fld-a' });
  assert.deepEqual(validated.folder, { folderToken: 'fld-a', name: '论文' });

  // 根目录校验：null 也显式带在 body 里
  await send({ type: 'VALIDATE_DRIVE_FOLDER', folderToken: null });
  assert.deepEqual(lastDriveValidateBody, { folderToken: null });
});

// ——— PDF 标签页场景（#67）：contentType 探针主判定 + URL 后缀兜底 + pdf-only 提交 ———

test('DETECT_PDF_TAB：探针命中 application/pdf 即判定（动态 URL 无 .pdf 后缀也覆盖）', async () => {
  tabUrl = 'https://arxiv.org/pdf/2401.00001';
  pdfTabProbeResult = { contentType: 'application/pdf', title: '2401.00001.pdf', sizeBytes: 2048 };
  try {
    const { pdfTab } = await send({ type: 'DETECT_PDF_TAB' });
    assert.equal(pdfTab.url, tabUrl);
    assert.equal(pdfTab.name, '2401.00001.pdf', '查看器 title 即文件名');
    assert.equal(pdfTab.sizeBytes, 2048);
  } finally {
    tabUrl = PAGE; pdfTabProbeResult = null;
  }
});

test('DETECT_PDF_TAB：探针 title 为空回退 URL 末段；非 PDF 页面（含 .pdf URL 的 HTML）不误判', async () => {
  tabUrl = 'https://example.com/download?id=123';
  pdfTabProbeResult = { contentType: 'application/pdf', title: '', sizeBytes: null };
  try {
    const { pdfTab } = await send({ type: 'DETECT_PDF_TAB' });
    assert.equal(pdfTab.name, 'download', 'title 为空回退 URL 末段');
    assert.equal(pdfTab.sizeBytes, null, 'HEAD 拿不到大小显示未知');

    // .pdf 后缀但 contentType 是 HTML（登录墙/错误页）：探针为准，不是 PDF 标签页
    tabUrl = 'https://example.com/paper.pdf';
    pdfTabProbeResult = { contentType: 'text/html' };
    assert.equal((await send({ type: 'DETECT_PDF_TAB' })).pdfTab, null);

    pdfTabProbeResult = null;
    assert.equal((await send({ type: 'DETECT_PDF_TAB' })).pdfTab, null, '探针无结果按非 PDF 处理');
  } finally {
    tabUrl = PAGE; pdfTabProbeResult = null;
  }
});

test('DETECT_PDF_TAB：注入失败回退 URL 后缀兜底（忽略 query/hash）；非 .pdf 兜底不命中', async () => {
  pdfTabProbeError = new Error('Cannot access contents of the page');
  try {
    tabUrl = 'https://example.com/paper.pdf?dl=1#page=2';
    const { pdfTab } = await send({ type: 'DETECT_PDF_TAB' });
    assert.equal(pdfTab.url, tabUrl);
    assert.equal(pdfTab.name, 'paper.pdf');
    assert.equal(pdfTab.sizeBytes, null, '兜底路径没有大小信息');

    tabUrl = 'https://example.com/paper.PDF';
    assert.ok((await send({ type: 'DETECT_PDF_TAB' })).pdfTab, '后缀匹配大小写不敏感');

    tabUrl = 'https://example.com/article';
    assert.equal((await send({ type: 'DETECT_PDF_TAB' })).pdfTab, null);
  } finally {
    tabUrl = PAGE; pdfTabProbeError = null;
  }
});

test('DETECT_PDF_TAB：非 http(s) 页面直接返回 null（不注入探针）', async () => {
  tabUrl = 'chrome://extensions';
  try {
    assert.equal((await send({ type: 'DETECT_PDF_TAB' })).pdfTab, null);
  } finally {
    tabUrl = PAGE;
  }
});

test('SAVE_PDF_TAB：只提交 pdf-only 任务体（无 snapshot/destination），写恢复指针', async () => {
  const before = storage.activeAttempt;
  await send({ type: 'SAVE_PDF_TAB', pdfSource: { url: PDF_URL, name: '2401.00001.pdf', sizeBytes: 2048 }, pdfFolderToken: 'fld-papers' });
  assert.ok(lastJobsBody.attemptId, 'background 生成 attemptId');
  assert.deepEqual(lastJobsBody.pdfSource, { type: 'url', url: PDF_URL, name: '2401.00001.pdf', sizeBytes: 2048 });
  assert.equal(lastJobsBody.pdfFolderToken, 'fld-papers');
  assert.equal(lastJobsBody.snapshot, undefined, 'pdf-only 提交不带快照');
  assert.equal(lastJobsBody.destination, undefined, 'pdf-only 提交不带剪藏目标');
  assert.equal(storage.activeAttempt, lastJobsBody.attemptId, '恢复指针指向本次 pdf 尝试');

  // 失败重试：弹窗复用同一 attemptId（bridge 对 failed pdf job 幂等复位重排）
  await send({ type: 'SAVE_PDF_TAB', attemptId: 'dddddddd-2222-4222-8222-222222222222', pdfSource: { url: PDF_URL } });
  assert.equal(lastJobsBody.attemptId, 'dddddddd-2222-4222-8222-222222222222');
  assert.equal(lastJobsBody.pdfFolderToken, null, '缺省目录 = 云盘根目录');
  storage.activeAttempt = before;
});

test('SAVE_PDF_TAB：非 http(s) 的 pdfSource 拒绝提交', async () => {
  await assert.rejects(send({ type: 'SAVE_PDF_TAB', pdfSource: { url: 'file:///Users/x/paper.pdf' } }), /PDF 地址不可用/);
  await assert.rejects(send({ type: 'SAVE_PDF_TAB' }), /PDF 地址不可用/);
});

// ——— 凭据回传（#68）：FEED_PDF_BYTES 的声明、切块、续传 ———

const FEED_ATTEMPT = '61616161-6161-4161-8161-616161616161';
const FEED_BODY_SIZE = 2 * 4 * 1024 * 1024 + 500; // 3 块：两块满块 + 500 字节末块

function resetFeedStubs(body) {
  postedChunks = [];
  chunkBitmap = [];
  lastJobsBody = null;
  pdfSourceServer = { body };
  feedJob = null;
}

test('FEED_PDF_BYTES：url 型 awaiting_bytes → 先声明（SHA-256/总块数）再逐块 POST', async () => {
  const body = randomBytes(FEED_BODY_SIZE);
  resetFeedStubs(body);
  feedJob = { attemptId: FEED_ATTEMPT, kind: 'pdf', status: 'awaiting_bytes', title: 'Paper', pdfSource: { type: 'url', url: PDF_SOURCE_URL, name: 'paywalled.pdf' } };
  try {
    const result = await send({ type: 'FEED_PDF_BYTES', attemptId: FEED_ATTEMPT, pdfUrl: PDF_SOURCE_URL });
    assert.deepEqual(result, { fed: true, uploaded: 3, totalChunks: 3 });

    // 第一遍流式读出的声明经 POST /v1/jobs 升级（同一 attemptId）
    assert.equal(lastJobsBody.attemptId, FEED_ATTEMPT);
    assert.equal(lastJobsBody.pdfSource.type, 'bytes');
    assert.equal(lastJobsBody.pdfSource.url, PDF_SOURCE_URL, '声明保留抓取地址');
    assert.equal(lastJobsBody.pdfSource.name, 'paywalled.pdf');
    assert.equal(lastJobsBody.pdfSource.sizeBytes, FEED_BODY_SIZE);
    assert.equal(lastJobsBody.pdfSource.totalChunks, 3);
    assert.equal(lastJobsBody.pdfSource.sha256, createHash('sha256').update(body).digest('hex'), '声明哈希 = 整文件 SHA-256');

    // 第二遍切块：按序 POST，块内容与原字节一致
    assert.deepEqual(postedChunks.map((chunk) => chunk.index), [0, 1, 2]);
    assert.ok(postedChunks.every((chunk) => chunk.totalChunks === 3));
    const chunkBytes = (index) => Buffer.from(postedChunks[index].dataBase64, 'base64');
    assert.equal(chunkBytes(0).length, 4 * 1024 * 1024);
    assert.equal(chunkBytes(2).length, 500, '末块为剩余字节');
    assert.ok(Buffer.concat([chunkBytes(0), chunkBytes(1), chunkBytes(2)]).equals(body), '切块拼接还原原文件');
  } finally {
    resetFeedStubs(null);
  }
});

test('FEED_PDF_BYTES：声明已在库时跳过第一遍；位图续传只补缺块', async () => {
  const body = randomBytes(FEED_BODY_SIZE);
  resetFeedStubs(body);
  feedJob = {
    attemptId: FEED_ATTEMPT, kind: 'pdf', status: 'awaiting_bytes', title: 'Paper',
    pdfSource: { type: 'bytes', url: PDF_SOURCE_URL, name: 'paywalled.pdf', sizeBytes: FEED_BODY_SIZE, totalChunks: 3, sha256: 'f'.repeat(64) },
  };
  chunkBitmap = [0, 1]; // 模拟中断前已确认两块
  try {
    const result = await send({ type: 'FEED_PDF_BYTES', attemptId: FEED_ATTEMPT, pdfUrl: PDF_SOURCE_URL });
    assert.deepEqual(result, { fed: true, uploaded: 1, totalChunks: 3 });
    assert.equal(lastJobsBody, null, '声明已就位不再重复提交');
    assert.deepEqual(postedChunks.map((chunk) => chunk.index), [2], '只补位图缺失的块，不重传已确认块');
  } finally {
    resetFeedStubs(null);
  }
});

test('FEED_PDF_BYTES：job 不在 awaiting_bytes 不动作；源站仍 401/403 报错可重试', async () => {
  resetFeedStubs(randomBytes(100));
  feedJob = { attemptId: FEED_ATTEMPT, kind: 'pdf', status: 'failed', pdfSource: { type: 'url', url: PDF_SOURCE_URL, name: 'x.pdf' } };
  try {
    assert.deepEqual(await send({ type: 'FEED_PDF_BYTES', attemptId: FEED_ATTEMPT, pdfUrl: PDF_SOURCE_URL }), { fed: false, status: 'failed' });
    assert.equal(lastJobsBody, null);
    assert.deepEqual(postedChunks, []);

    feedJob = { attemptId: FEED_ATTEMPT, kind: 'pdf', status: 'awaiting_bytes', pdfSource: { type: 'url', url: PDF_SOURCE_URL, name: 'x.pdf' } };
    pdfSourceServer = { failStatus: 401 };
    await assert.rejects(
      send({ type: 'FEED_PDF_BYTES', attemptId: FEED_ATTEMPT, pdfUrl: PDF_SOURCE_URL }),
      (error) => error.code === 'PDF_SOURCE_AUTH',
    );
    pdfSourceServer = { failStatus: 500 };
    await assert.rejects(
      send({ type: 'FEED_PDF_BYTES', attemptId: FEED_ATTEMPT, pdfUrl: PDF_SOURCE_URL }),
      (error) => error.code === 'PDF_SOURCE_FETCH_FAILED',
    );
  } finally {
    resetFeedStubs(null);
  }
});
