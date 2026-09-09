// background.js 消息处理回归：桩 chrome.* + fetch，通过真实 onMessage 监听器驱动。
// job 恢复指针（activeAttempt）的生命周期：CLIP 时写入/覆盖，查询（GET_JOB）永远不清——
// 清除会让「保存完成后重开弹窗看不到成功态」（用户实测 bug）：
// 跨页打开弹窗一次（终态 job 被静默丢弃是对的）顺带把指针清了，回到原页面也无状态可恢复。
import assert from 'node:assert/strict';
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
let lastJobsBody = null; // CLIP 转发给 bridge 的 POST /v1/jobs 请求体
let stubSnapshotPdf = null; // 非 null 时 extractor 桩的快照带 pdf 识别结果（#65）
let detectPdfResult = { pdf: null }; // pdf-detect.js 桩的探测结果
globalThis.chrome = {
  runtime: { id: 'ext-id', onMessage: { addListener: (fn) => listeners.push(fn) } },
  tabs: { query: async () => [{ id: 1, url: PAGE }] },
  scripting: {
    executeScript: async ({ files } = {}) => {
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
  if (url.endsWith('/v1/jobs') && options?.method === 'POST') lastJobsBody = JSON.parse(options.body);
  return {
    ok: true,
    json: async () => (url.includes(`/v1/jobs/${ATTEMPT}`) ? { ok: true, job: terminalJob } : { ok: true, job: { attemptId: 'new-attempt' } }),
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
