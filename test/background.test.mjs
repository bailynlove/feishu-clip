// background.js 消息处理回归：桩 chrome.* + fetch，通过真实 onMessage 监听器驱动。
// job 恢复指针（activeAttempt）的生命周期：CLIP 时写入/覆盖，查询（GET_JOB）永远不清——
// 清除会让「保存完成后重开弹窗看不到成功态」（用户实测 bug）：
// 跨页打开弹窗一次（终态 job 被静默丢弃是对的）顺带把指针清了，回到原页面也无状态可恢复。
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
let stubSnapshotPdfAttachments = null;
let detectPdfResult = { pdf: null }; // pdf-detect.js 桩的探测结果
let tabUrl = PAGE; // 当前标签页 URL 桩（#67 探测用例会换 URL）
let pdfTabProbeResult = null; // DETECT_PDF_TAB 探针（func 注入）返回值
let pdfTabProbeError = null; // 非 null 时探针注入失败（走 URL 后缀兜底）
let pdfHeadStub = 'application/pdf'; // 兜底 HEAD 的 content-type；null = HEAD 网络失败
// ——— AI 摘要（#75）/ provider 预设（#77）：LIST/SAVE/DELETE/TEST 代理端点的桩状态 ———
let lastAiProviderBody = null; // SAVE_AI_PROVIDER 转发给 bridge 的 POST /v1/ai/providers 请求体
let lastAiDeleteBody = null; // DELETE_AI_PROVIDER 转发给 bridge 的 POST /v1/ai/providers/delete 请求体
let lastAiTestBody = null; // TEST_AI 转发给 bridge 的 POST /v1/ai/test 请求体
let lastProxyBody = null;
// ——— 凭据回传（#68）FEED_PDF_BYTES 用例的桩状态 ———
const PDF_SOURCE_URL = 'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=11146309&ref=';
const IEEE_PAGE_URL = 'https://ieeexplore.ieee.org/document/11146309';
let pdfSourceServer = null; // 非 null 时源站 URL 返回流式 Response；{ body } / { failStatus } / { challengeOnce, body }
let pdfSourceRequests = 0;
let feedJob = null; // FEED 用例的 pdf job 视图（GET /v1/jobs/:id 返回）
let chunkBitmap = []; // pdf-chunks GET 返回的位图
let postedChunks = []; // 记录分块 POST 请求体
let replacedDeclaration = null;
let verificationWindows = [];
let removedWindows = [];
const pdfCacheEntries = new Map();
globalThis.caches = {
  async open() {
    return {
      async match(key) {
        const entry = pdfCacheEntries.get(String(key));
        return entry ? new Response(entry.bytes.slice(), { status: 200, headers: entry.headers }) : undefined;
      },
      async put(key, response) {
        pdfCacheEntries.set(String(key), {
          bytes: new Uint8Array(await response.arrayBuffer()),
          headers: { 'content-type': response.headers.get('content-type') || '' },
        });
      },
      async delete(key) { return pdfCacheEntries.delete(String(key)); },
    };
  },
};
globalThis.chrome = {
  runtime: { id: 'ext-id', onMessage: { addListener: (fn) => listeners.push(fn) } },
  tabs: { query: async () => [{ id: 1, url: tabUrl }] },
  windows: {
    async create(options) {
      const window = { id: 70 + verificationWindows.length, ...options };
      verificationWindows.push(window);
      return window;
    },
    async get(id) {
      const window = verificationWindows.find((item) => item.id === id && !removedWindows.includes(id));
      if (!window) throw new Error('No window');
      return window;
    },
    async remove(id) { removedWindows.push(id); },
  },
  scripting: {
    executeScript: async ({ files, func } = {}) => {
      if (func) {
        if (pdfTabProbeError) throw pdfTabProbeError;
        return [{ result: pdfTabProbeResult }];
      }
      if (files?.[0] === 'pdf-detect.js') return [{ result: detectPdfResult }];
      return [{
        result: { title: '页面标题', sourceUrl: PAGE, capturedAt: '2026-09-02T00:00:00.000Z', markdown: '# 正文', images: [], ...(stubSnapshotPdf ? { pdf: stubSnapshotPdf } : {}), ...(stubSnapshotPdfAttachments ? { pdfAttachments: stubSnapshotPdfAttachments } : {}) },
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
  // DETECT_PDF_TAB 注入失败兜底（#67）：SW 对疑似 .pdf URL 的 HEAD content-type 校验
  if (options?.method === 'HEAD') {
    if (pdfHeadStub === null) throw new Error('network down');
    return { ok: true, headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? pdfHeadStub : null) } };
  }
  // 源站 PDF（#68 凭据抓取）：流式 Response，分段 enqueue 模拟真实流
  if (url === PDF_SOURCE_URL && pdfSourceServer) {
    pdfSourceRequests += 1;
    if (pdfSourceServer.challengeOnce && !pdfSourceServer.challenged) {
      pdfSourceServer.challenged = true;
      return new Response('<html>challenge</html>', { status: pdfSourceServer.challengeStatus ?? 202, headers: { 'content-type': 'text/html', 'x-amzn-waf-action': 'challenge' } });
    }
    if (pdfSourceServer.failStatus) return { ok: false, status: pdfSourceServer.failStatus, headers: { get: () => null }, body: null };
    const bytes = pdfSourceServer.bodies?.[pdfSourceRequests - 1] ?? pdfSourceServer.body;
    return new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 1000) controller.enqueue(bytes.subarray(offset, offset + 1000));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': pdfSourceServer.contentType ?? 'application/pdf' } });
  }
  // 分块通道端点（#68）
  if (url.includes('/pdf-chunks')) {
    if (options?.method === 'POST') {
      postedChunks.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, complete: false, received: chunkBitmap.length + postedChunks.length }) };
    }
    return { ok: true, json: async () => ({ ok: true, declared: feedJob?.pdfSource?.type === 'bytes', totalChunks: feedJob?.pdfSource?.totalChunks ?? null, bitmap: chunkBitmap }) };
  }
  if (url.includes('/pdf-declaration') && options?.method === 'PUT') {
    replacedDeclaration = JSON.parse(options.body).pdfSource;
    feedJob.pdfSource = replacedDeclaration;
    return { ok: true, json: async () => ({ ok: true, pdfJob: feedJob }) };
  }
  if (url.endsWith('/v1/jobs') && options?.method === 'POST') lastJobsBody = JSON.parse(options.body);
  if (url.endsWith('/v1/drive/folders/validate')) lastDriveValidateBody = JSON.parse(options.body);
  else if (url.includes('/v1/drive/folders')) lastDriveListUrl = url;
  // AI provider（#77）代理端点
  if (url.endsWith('/v1/ai/providers') && options?.method === 'POST') lastAiProviderBody = JSON.parse(options.body);
  if (url.endsWith('/v1/ai/providers/delete') && options?.method === 'POST') lastAiDeleteBody = JSON.parse(options.body);
  if (url.endsWith('/v1/ai/test') && options?.method === 'POST') lastAiTestBody = JSON.parse(options.body);
  if (url.endsWith('/v1/settings/proxy') && options?.method === 'POST') lastProxyBody = JSON.parse(options.body);
  return {
    ok: true,
    json: async () => {
      if (feedJob && url.includes(`/v1/jobs/${feedJob.attemptId}`)) return { ok: true, jobs: [feedJob] };
      if (url.includes(`/v1/jobs/${ATTEMPT}`)) return { ok: true, job: terminalJob };
      if (url.endsWith('/v1/drive/folders/validate')) return { ok: true, folder: { folderToken: lastDriveValidateBody.folderToken ?? null, name: '论文' } };
      if (url.includes('/v1/drive/folders')) return { ok: true, items: [{ folderToken: 'fld-a', name: '论文', type: 'folder' }], hasMore: false, nextPageToken: null };
      if (url.endsWith('/v1/ai/providers/delete')) return { ok: true };
      if (url.endsWith('/v1/ai/providers')) {
        if (options?.method === 'POST') return { ok: true, provider: { name: lastAiProviderBody.name, apiType: lastAiProviderBody.apiType, baseUrl: lastAiProviderBody.baseUrl, model: lastAiProviderBody.model, hasKey: Boolean(lastAiProviderBody.apiKey) } };
        return { ok: true, providers: [{ name: '默认', apiType: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', hasKey: true }] };
      }
      if (url.endsWith('/v1/ai/test')) return { ok: true, latencyMs: 320, reply: 'ok' };
      if (url.endsWith('/v1/settings/proxy')) return { ok: true, proxyPort: lastProxyBody?.proxyPort ?? 7897 };
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

test('CLIP 透传 PDF 保存失败策略，非法或缺省值归一为继续', async () => {
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: true, pdfSource: { url: PDF_URL }, pdfFailurePolicy: 'abort' });
  assert.equal(lastJobsBody.pdfFailurePolicy, 'abort');
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: true, pdfSource: { url: PDF_URL }, pdfFailurePolicy: 'wat' });
  assert.equal(lastJobsBody.pdfFailurePolicy, 'continue');
});

test('重试 PDF：弹窗复用同一 attemptId 重发 CLIP，原样透传给 bridge（bridge 侧幂等复位重排）', async () => {
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, attemptId: 'aaaaaaaa-1111-4111-8111-111111111111', pdfEnabled: true, pdfSource: { url: PDF_URL } });
  assert.equal(lastJobsBody.attemptId, 'aaaaaaaa-1111-4111-8111-111111111111');
});

test('CLIP 的多个 PDF source 保留稳定 attachmentId 与主文件标记', async () => {
  stubSnapshotPdfAttachments = [
    { id: 'supplement', url: 'https://example.test/supplement.pdf' },
    { id: 'main-paper', url: 'https://example.test/main.pdf', primary: true },
  ];
  try {
    await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, pdfEnabled: true });
    assert.deepEqual(lastJobsBody.pdfSources.map(({ attachmentId, primary }) => ({ attachmentId, primary })), [
      { attachmentId: 'supplement', primary: false },
      { attachmentId: 'main-paper', primary: true },
    ]);
    assert.equal(lastJobsBody.primaryAttachmentId, 'main-paper');
    assert.equal(lastJobsBody.pdfSource.url, 'https://example.test/main.pdf');
  } finally {
    stubSnapshotPdfAttachments = null;
  }
});

test('DETECT_PDF：缺少 offscreen 能力时保守返回 null', async () => {
  assert.equal((await send({ type: 'DETECT_PDF' })).pdf, null);
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
  assert.equal(root.items[0].folderToken, 'fld-a');

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

test('DETECT_PDF_TAB：注入失败回退 URL 后缀 + HEAD 校验（忽略 query/hash）；非 .pdf 不命中', async () => {
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

// 注入失败兜底误判防护（review #67）：HEAD content-type 不符（HTML 登录墙）或 HEAD 网络失败
// 一律保守不判，不进 PDF 面板；content-type 含 application/pdf 才通过
test('DETECT_PDF_TAB：注入失败时 HEAD content-type 不符/网络失败均保守不判', async () => {
  pdfTabProbeError = new Error('Cannot access contents of the page');
  try {
    // .pdf 后缀但 HEAD 返回 HTML（登录墙）：不误判
    tabUrl = 'https://example.com/paper.pdf';
    pdfHeadStub = 'text/html; charset=utf-8';
    assert.equal((await send({ type: 'DETECT_PDF_TAB' })).pdfTab, null, 'HTML 登录墙不进入 PDF 面板');

    // HEAD 网络失败：保守不判
    pdfHeadStub = null;
    assert.equal((await send({ type: 'DETECT_PDF_TAB' })).pdfTab, null, 'HEAD 失败保守处理');

    // content-type 含 application/pdf（带参数也命中）：通过
    pdfHeadStub = 'application/pdf; charset=binary';
    const { pdfTab } = await send({ type: 'DETECT_PDF_TAB' });
    assert.equal(pdfTab.url, tabUrl);
    assert.equal(pdfTab.name, 'paper.pdf');
  } finally {
    tabUrl = PAGE; pdfTabProbeError = null; pdfHeadStub = 'application/pdf';
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
  replacedDeclaration = null;
  chunkBitmap = [];
  lastJobsBody = null;
  pdfSourceServer = { body };
  pdfSourceRequests = 0;
  feedJob = null;
  verificationWindows = [];
  removedWindows = [];
  pdfCacheEntries.clear();
}

function pdfBytes(size) {
  const bytes = randomBytes(size);
  bytes.set(Buffer.from('%PDF-'));
  return bytes;
}

test('FEED_PDF_BYTES：url 型 awaiting_bytes → 先声明（SHA-256/总块数）再逐块 POST', async () => {
  const body = pdfBytes(FEED_BODY_SIZE);
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

test('FEED_PDF_BYTES：动态 PDF 只抓取一次，声明与上传复用同一响应', async () => {
  const first = pdfBytes(4096);
  const changed = pdfBytes(5000);
  resetFeedStubs(first);
  pdfSourceServer = { body: first, bodies: [first, changed] };
  feedJob = { attemptId: FEED_ATTEMPT, kind: 'pdf', status: 'awaiting_bytes', title: 'Paper', pdfSource: { type: 'url', url: PDF_SOURCE_URL, name: 'dynamic.pdf' } };
  try {
    const result = await send({ type: 'FEED_PDF_BYTES', attemptId: FEED_ATTEMPT, pdfUrl: PDF_SOURCE_URL });
    assert.deepEqual(result, { fed: true, uploaded: 1, totalChunks: 1 });
    assert.equal(pdfSourceRequests, 1, '源站动态生成 PDF 时不得用第二次请求上传另一份内容');
    assert.equal(lastJobsBody.pdfSource.sizeBytes, first.byteLength);
    assert.ok(Buffer.from(postedChunks[0].dataBase64, 'base64').equals(first));
  } finally {
    resetFeedStubs(null);
  }
});

test('FEED_PDF_BYTES：声明已在库时跳过第一遍；位图续传只补缺块', async () => {
  const body = pdfBytes(FEED_BODY_SIZE);
  resetFeedStubs(body);
  feedJob = {
    attemptId: FEED_ATTEMPT, kind: 'pdf', status: 'awaiting_bytes', title: 'Paper',
    pdfSource: { type: 'bytes', url: PDF_SOURCE_URL, name: 'paywalled.pdf', sizeBytes: FEED_BODY_SIZE, totalChunks: 3, sha256: createHash('sha256').update(body).digest('hex') },
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

test('FEED_PDF_BYTES：旧声明没有缓存且源站内容已变化时，空位图允许替换声明', async () => {
  const body = pdfBytes(6000);
  resetFeedStubs(body);
  feedJob = {
    attemptId: FEED_ATTEMPT, kind: 'pdf', status: 'awaiting_bytes', title: 'Paper',
    pdfSource: { type: 'bytes', url: PDF_SOURCE_URL, name: 'dynamic.pdf', sizeBytes: 4096, totalChunks: 1, sha256: 'f'.repeat(64) },
  };
  try {
    const result = await send({ type: 'FEED_PDF_BYTES', attemptId: FEED_ATTEMPT, pdfUrl: PDF_SOURCE_URL });
    assert.deepEqual(result, { fed: true, uploaded: 1, totalChunks: 1 });
    assert.equal(replacedDeclaration.sizeBytes, body.byteLength);
    assert.equal(replacedDeclaration.sha256, createHash('sha256').update(body).digest('hex'));
  } finally {
    resetFeedStubs(null);
  }
});

test('FEED_PDF_BYTES：job 不在 awaiting_bytes 不动作；源站仍 401/403 报错可重试', async () => {
  resetFeedStubs(pdfBytes(100));
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

test('FEED_PDF_BYTES：IEEE challenge 打开来源页验证窗口，验证通过后自动重试并关闭', async () => {
  const body = pdfBytes(4096);
  resetFeedStubs(body);
  pdfSourceServer = { body, challengeOnce: true, challengeStatus: 418 };
  feedJob = {
    attemptId: FEED_ATTEMPT, kind: 'pdf', status: 'awaiting_bytes', title: 'Paper', sourceUrl: IEEE_PAGE_URL,
    pdfSource: { type: 'url', url: PDF_SOURCE_URL, name: 'paper.pdf' },
  };
  try {
    const result = await send({ type: 'FEED_PDF_BYTES', attemptId: FEED_ATTEMPT, pdfUrl: PDF_SOURCE_URL });
    assert.deepEqual(result, { fed: true, uploaded: 1, totalChunks: 1 });
    assert.equal(verificationWindows.length, 1);
    assert.equal(verificationWindows[0].url, IEEE_PAGE_URL, '验证窗口打开用户原先访问的论文页');
    assert.equal(verificationWindows[0].type, 'popup');
    assert.deepEqual(removedWindows, [verificationWindows[0].id], '验证通过后自动关闭窗口');
  } finally {
    resetFeedStubs(null);
  }
});

test('FEED_PDF_BYTES：HTTP 200 的 HTML 页面不会被声明或上传为 PDF', async () => {
  const body = Buffer.from('<html>unable to load page</html>');
  resetFeedStubs(body);
  pdfSourceServer = { body, contentType: 'text/html' };
  feedJob = { attemptId: FEED_ATTEMPT, kind: 'pdf', status: 'awaiting_bytes', sourceUrl: PAGE, pdfSource: { type: 'url', url: PDF_SOURCE_URL, name: 'x.pdf' } };
  try {
    await assert.rejects(
      send({ type: 'FEED_PDF_BYTES', attemptId: FEED_ATTEMPT, pdfUrl: PDF_SOURCE_URL }),
      (error) => error.code === 'PDF_SOURCE_TYPE',
    );
    assert.equal(lastJobsBody, null);
    assert.deepEqual(postedChunks, []);
  } finally {
    resetFeedStubs(null);
  }
});

// ——— AI 摘要（#75）：CLIP 的 digest 字段流 + AI 配置代理端点 ———

import { DEFAULT_DIGEST_INSTRUCTION } from '../src/extension/presets.js';

test('GET_SETTINGS 返回 aiDigestInstruction（全局摘要指令，供设置页与 CLIP 回落）', async () => {
  storage.aiDigestInstruction = '全局指令';
  try {
    const settings = await send({ type: 'GET_SETTINGS' });
    assert.equal(settings.aiDigestInstruction, '全局指令');
  } finally {
    delete storage.aiDigestInstruction;
  }
});

test('本地代理设置通过 background 转发给 Bridge', async () => {
  assert.equal((await send({ type: 'GET_PROXY_SETTINGS' })).proxyPort, 7897);
  assert.equal((await send({ type: 'SAVE_PROXY_SETTINGS', proxyPort: 8080 })).proxyPort, 8080);
  assert.deepEqual(lastProxyBody, { proxyPort: 8080 });
});

test('CLIP digestEnabled：{{digest}} 以字面量穿过正文渲染，digest 随任务上报 bridge', async () => {
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, title: 'T', customBody: '{{digest}}\n\n{{content}}', digestEnabled: true, digestInstruction: '预设指令' });
  assert.deepEqual(lastJobsBody.digest, { enabled: true, instruction: '预设指令', mode: 'subdoc', docTitle: 'Digest' }, 'mode 缺省 subdoc、docTitle 缺省 Digest（#98）');
  assert.ok(lastJobsBody.snapshot.markdown.startsWith('{{digest}}\n\n# 正文'), '占位符字面量原位保留进 snapshot.markdown');

  // 带空格写法归一
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, title: 'T', customBody: '{{ digest }} {{content}}', digestEnabled: true, digestInstruction: 'x' });
  assert.ok(lastJobsBody.snapshot.markdown.startsWith('{{digest}} # 正文'), '{{ digest }} 归一为 {{digest}}');
});

// mode/docTitle（#98）：mode 由弹窗按预设透传（inline 原样、缺省 subdoc）；
// docTitle 用与正文同一模板上下文渲染预设级 docTitleTemplate，空白回落 Digest
test('CLIP digestEnabled：mode 透传与 docTitle 模板渲染（#98）', async () => {
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, title: '深入理解剪藏', digestEnabled: true, digestInstruction: 'x', digestMode: 'inline' });
  assert.equal(lastJobsBody.digest.mode, 'inline', 'inline 原样透传（可还原）');
  assert.equal(lastJobsBody.digest.docTitle, 'Digest', '模板缺省回落 Digest');

  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, title: '深入理解剪藏', digestEnabled: true, digestInstruction: 'x', digestMode: 'subdoc', digestDocTitleTemplate: '摘要 · {{title}}' });
  assert.equal(lastJobsBody.digest.mode, 'subdoc');
  assert.equal(lastJobsBody.digest.docTitle, '摘要 · 深入理解剪藏', 'docTitleTemplate 用剪藏上下文渲染（{{title}} 等变量生效）');

  // 模板渲成空白 → 回落 Digest
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, title: 'T', digestEnabled: true, digestInstruction: 'x', digestDocTitleTemplate: '{{unknown}}' });
  assert.equal(lastJobsBody.digest.docTitle, 'Digest', '渲染空白回落 Digest');

  // 非法 mode 按缺省 subdoc 归一
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, title: 'T', digestEnabled: true, digestInstruction: 'x', digestMode: 'weird' });
  assert.equal(lastJobsBody.digest.mode, 'subdoc', '非法 mode 归一 subdoc');
});

test('CLIP digestEnabled 指令回落顺序：预设级 > 全局 > 内置默认；长指令不截断', async () => {
  const destination = { kind: 'node', nodeToken: 'n1' };
  try {
    // 预设级与全局都未设置 → 内置默认（陈旧弹窗发来空指令也不会落空）
    delete storage.aiDigestInstruction;
    await send({ type: 'CLIP', destination, digestEnabled: true });
    assert.equal(lastJobsBody.digest.instruction, DEFAULT_DIGEST_INSTRUCTION);

    // 预设空串 → 全局
    storage.aiDigestInstruction = '全局指令';
    await send({ type: 'CLIP', destination, digestEnabled: true, digestInstruction: '' });
    assert.equal(lastJobsBody.digest.instruction, '全局指令');

    // 预设级优先于全局
    await send({ type: 'CLIP', destination, digestEnabled: true, digestInstruction: '预设指令' });
    assert.equal(lastJobsBody.digest.instruction, '预设指令');

    // 长指令不截断（4000 上限已取消——截断曾切掉尾部 {{@file}} 导致 AI 收不到 PDF）
    await send({ type: 'CLIP', destination, digestEnabled: true, digestInstruction: '长'.repeat(5000) });
    assert.equal(lastJobsBody.digest.instruction.length, 5000, '长指令原样进 body');

    // provider（#78）：digestProvider 非空随 digest 落 body；空串/缺省不带该键（= 默认 provider）
    await send({ type: 'CLIP', destination, digestEnabled: true, digestProvider: 'ds' });
    assert.equal(lastJobsBody.digest.provider, 'ds');
    await send({ type: 'CLIP', destination, digestEnabled: true, digestProvider: '  ' });
    assert.ok(!('provider' in lastJobsBody.digest), '空白 provider 不带键');
    await send({ type: 'CLIP', destination, digestEnabled: true, digestProvider: 'x'.repeat(65) });
    assert.equal(lastJobsBody.digest.provider.length, 64, 'provider 名截断到 64（bridge 上限）');
  } finally {
    delete storage.aiDigestInstruction;
  }
});

test('CLIP 未开 digestEnabled：不上报 digest，{{digest}} 按未知变量置空', async () => {
  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, title: 'T', customBody: '{{digest}} {{content}}', digestInstruction: '预设指令' });
  assert.equal(lastJobsBody.digest, null, '缺省等同关闭');
  assert.ok(!lastJobsBody.snapshot.markdown.includes('{{digest}}'), '未开开关时占位符置空');

  await send({ type: 'CLIP', destination: { kind: 'node', nodeToken: 'n1' }, digestEnabled: false, digestInstruction: '预设指令' });
  assert.equal(lastJobsBody.digest, null);
});

test('LIST_AI_PROVIDERS / SAVE_AI_PROVIDER / DELETE_AI_PROVIDER / TEST_AI 代理到 bridge 的 provider 端点族（#77）', async () => {
  const loaded = await send({ type: 'LIST_AI_PROVIDERS' });
  assert.deepEqual(loaded.providers.map((p) => p.name), ['默认']);
  assert.equal(loaded.providers[0].hasKey, true);
  assert.equal('apiKey' in loaded.providers[0], false, '列表不回传 key');

  const saved = await send({ type: 'SAVE_AI_PROVIDER', provider: { name: 'ds', apiType: 'messages', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5', apiKey: 'sk-ant' } });
  assert.deepEqual(lastAiProviderBody, { name: 'ds', apiType: 'messages', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5', apiKey: 'sk-ant' });
  assert.equal(saved.provider.hasKey, true);

  const deleted = await send({ type: 'DELETE_AI_PROVIDER', name: 'ds' });
  assert.deepEqual(lastAiDeleteBody, { name: 'ds' });
  assert.equal(deleted.ok, true);

  const tested = await send({ type: 'TEST_AI', name: 'ds', overrides: { apiType: 'responses', model: 'gpt-5-mini' } });
  assert.deepEqual(lastAiTestBody, { name: 'ds', apiType: 'responses', model: 'gpt-5-mini' }, 'name 与可选覆盖原样转发');
  assert.equal(tested.ok, true);
  assert.equal(tested.reply, 'ok');

  await send({ type: 'TEST_AI' });
  assert.deepEqual(lastAiTestBody, {}, '省略 name/覆盖发空对象（bridge 用默认 provider 逐项回落）');
});

// 凭据回传（#68）的 SW fetch 依赖目标站 host 权限才能绕开 CORS——MDPI 实测：
// 无权限时跨域 fetch 直接 TypeError（连 403 分支都到不了），回传路径对所有真实站点全灭。
// manifest 回归守卫：host_permissions 必须覆盖任意 http(s) 站点。
test('manifest：host_permissions 覆盖任意站点，凭据回传的 SW fetch 不受 CORS 拦截', async () => {
  const manifest = JSON.parse(await readFile(new URL('../src/extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.host_permissions.includes('https://*/*'), '需含 https://*/*');
  assert.ok(manifest.host_permissions.includes('http://*/*'), '需含 http://*/*');
});
