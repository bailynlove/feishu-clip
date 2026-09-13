import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBridge } from '../src/bridge/server.mjs';
import { PDF_CHUNK_BYTES } from '../src/bridge/job-store.mjs';

const origin = `chrome-extension://${'b'.repeat(32)}`;

test('Bridge enforces Origin+credential, validates target, queues and completes a clip', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-server-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const code = 'correct-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  const fakeLark = {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    validateDestination: async ({ nodeToken }) => ({ nodeToken, spaceId: 'space-1', title: '验收目录', objType: 'docx' }),
    run: async (args) => {
      // 新管线一次 blocks 拉取定位锚点：返回含锚点段落的块列表
      if (args[0] === 'api' && args[1] === 'GET' && args[2].endsWith('/blocks')) {
        return { ok: true, data: { has_more: false, items: [
          { block_id: 'root', parent_id: '', block_type: 1, children: ['p0'] },
          { block_id: 'p0', parent_id: 'root', block_type: 2, text: { elements: [{ text_run: { content: '[[FEISHU_CLIP_IMAGE:0]]' } }] } },
        ] } };
      }
      if (args[0] === 'api' && args[1] === 'POST') return { ok: true, data: { children: [{ block_id: 'i0' }] } };
      if (args[0] === 'api') return { ok: true, data: {} };
      assert.equal(args[0], 'docs');
      if (args[1] === '+media-upload') return { ok: true, data: { file_token: 'tok' } };
      return { ok: true, data: { document: { document_id: 'docx-1', url: 'https://example.feishu.cn/wiki/docx-1' } } };
    },
  };
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark,
    logger: { error() {}, log() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try {
    assert.equal((await call('/v1/status')).status, 401);
    const paired = await (await call('/v1/pair', { method: 'POST', body: JSON.stringify({ code }) })).json();
    assert.equal(paired.ok, true);
    assert.equal((await call('/v1/status', { headers: { Authorization: `Bearer ${paired.credential}` } })).status, 200);
    const mv3Status = await fetch(`${base}/v1/status`, { headers: { 'X-Feishu-Clip-Origin': origin, Authorization: `Bearer ${paired.credential}` } });
    assert.equal(mv3Status.status, 200, 'MV3 service-worker GET omits Origin but supplies its explicit extension claim');
    const conflictingClaim = await fetch(`${base}/v1/status`, { headers: { Origin: `chrome-extension://${'c'.repeat(32)}`, 'X-Feishu-Clip-Origin': origin, Authorization: `Bearer ${paired.credential}` } });
    assert.equal(conflictingClaim.status, 401);
    assert.equal((await fetch(`${base}/v1/status`, { headers: { Origin: `chrome-extension://${'c'.repeat(32)}`, Authorization: `Bearer ${paired.credential}` } })).status, 401);

    const attemptId = '11111111-1111-4111-8111-111111111111';
    const submitted = await call('/v1/jobs', {
      method: 'POST', headers: { Authorization: `Bearer ${paired.credential}` },
      body: JSON.stringify({ attemptId, destination: { nodeToken: 'wikcn-parent' }, includeImages: true, snapshot: { title: '测试网页', sourceUrl: 'https://example.com/article', capturedAt: new Date().toISOString(), markdown: '# 正文\n\n[[FEISHU_CLIP_IMAGE:0]]', images: [{ label: '测试图片', source: 'blob:https://example.com/id', mimeType: 'image/png', bytesBase64: Buffer.alloc(32).toString('base64') }] } }),
    });
    assert.equal(submitted.status, 202);
    let job;
    for (let count = 0; count < 30; count += 1) {
      const body = await (await call(`/v1/jobs/${attemptId}`, { headers: { Authorization: `Bearer ${paired.credential}` } })).json();
      job = body.jobs?.find((j) => (j.kind ?? 'clip') === 'clip') ?? body.jobs?.[0];
      if (job.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, 'succeeded');
    assert.equal(job.document.url, 'https://example.feishu.cn/wiki/docx-1');
    assert.equal(job.snapshot, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('GET /v1/jobs lists recent jobs with timing fields and without snapshots; clientTiming is validated', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-server-jobs-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const code = 'another-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  const fakeLark = {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    validateDestination: async ({ nodeToken }) => ({ nodeToken, spaceId: 'space-1', title: '验收目录', objType: 'docx' }),
    run: async () => ({ ok: true, data: { document: { document_id: 'docx-1', url: 'https://example.feishu.cn/wiki/docx-1' } } }),
  };
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark,
    logger: { error() {}, log() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try {
    const paired = await (await call('/v1/pair', { method: 'POST', body: JSON.stringify({ code }) })).json();
    const auth = { Authorization: `Bearer ${paired.credential}` };

    assert.equal((await call('/v1/jobs')).status, 401, '未配对不得读取任务列表');

    // clientTiming 校验：非法 extractMs 一律 400
    const snapshot = { title: '计时网页', sourceUrl: 'https://example.com/timed', capturedAt: new Date().toISOString(), markdown: '# 正文' };
    for (const bad of [{ extractMs: -1 }, { extractMs: 600_001 }, { extractMs: 'fast' }, { extractMs: Number.NaN }, 'fast']) {
      const rejected = await call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ attemptId: 'aaaaaaaa-1111-4111-8111-111111111111', destination: { nodeToken: 'wikcn-parent' }, includeImages: false, snapshot, clientTiming: bad }) });
      assert.equal(rejected.status, 400, `clientTiming=${JSON.stringify(bad)} 应被拒绝`);
    }

    const first = await call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ attemptId: 'bbbbbbbb-1111-4111-8111-111111111111', destination: { nodeToken: 'wikcn-parent' }, includeImages: false, snapshot, clientTiming: { extractMs: 250 } }) });
    assert.equal(first.status, 202);
    const second = await call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ attemptId: 'cccccccc-1111-4111-8111-111111111111', destination: { nodeToken: 'wikcn-parent' }, includeImages: false, snapshot: { ...snapshot, title: '第二篇' } }) });
    assert.equal(second.status, 202);

    for (const badLimit of ['0', '51', 'abc', '1.5']) {
      assert.equal((await call(`/v1/jobs?limit=${badLimit}`, { headers: auth })).status, 400, `limit=${badLimit} 应被拒绝`);
    }

    const listed = await (await call('/v1/jobs', { headers: auth })).json();
    assert.equal(listed.ok, true);
    assert.equal(listed.jobs.length, 2);
    assert.equal(listed.jobs[0].attemptId, 'cccccccc-1111-4111-8111-111111111111', '新的在前');
    assert.equal(listed.jobs[1].attemptId, 'bbbbbbbb-1111-4111-8111-111111111111');
    assert.equal(listed.jobs[0].title, '第二篇');
    assert.ok(Array.isArray(listed.jobs[0].timeline));
    assert.ok('totalMs' in listed.jobs[0] && 'clientTiming' in listed.jobs[0]);
    assert.deepEqual(listed.jobs[1].clientTiming, { extractMs: 250 });
    assert.ok(!JSON.stringify(listed).includes('# 正文'), '列表不得泄露 snapshot 正文');

    const limited = await (await call('/v1/jobs?limit=1', { headers: auth })).json();
    assert.equal(limited.jobs.length, 1);
    assert.equal(limited.jobs[0].attemptId, 'cccccccc-1111-4111-8111-111111111111');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// 图片写入模式（#53）：bridge 接受三态 imageMode 落库；非法/缺省回退旧 includeImages 布尔语义
test('POST /v1/jobs persists imageMode and derives includeImages; invalid values fall back to the legacy boolean', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-server-mode-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const code = 'mode-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  const fakeLark = {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    validateDestination: async ({ nodeToken }) => ({ nodeToken, spaceId: 'space-1', title: '验收目录', objType: 'docx' }),
    run: async () => ({ ok: true, data: { document: { document_id: 'docx-1', url: 'https://example.feishu.cn/wiki/docx-1' } } }),
  };
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark,
    logger: { error() {}, log() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try {
    const paired = await (await call('/v1/pair', { method: 'POST', body: JSON.stringify({ code }) })).json();
    const auth = { Authorization: `Bearer ${paired.credential}` };
    const snapshot = { title: '模式网页', sourceUrl: 'https://example.com/mode', capturedAt: new Date().toISOString(), markdown: '# 正文' };
    const submit = (id, extra) => call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ attemptId: id, destination: { nodeToken: 'wikcn-parent' }, snapshot, ...extra }) });
    const readJob = async (id) => {
      const body = await (await call(`/v1/jobs/${id}`, { headers: auth })).json();
      return body.jobs?.find((j) => (j.kind ?? 'clip') === 'clip') ?? body.jobs?.[0];
    };

    assert.equal((await submit('dddddddd-1111-4111-8111-111111111111', { imageMode: 'download' })).status, 202);
    assert.equal((await submit('eeeeeeee-1111-4111-8111-111111111111', { imageMode: 'off' })).status, 202);
    assert.equal((await submit('ffffffff-1111-4111-8111-111111111111', { imageMode: 'bogus', includeImages: false })).status, 202);
    assert.equal((await submit('99999999-1111-4111-8111-111111111111', {})).status, 202);

    const download = await readJob('dddddddd-1111-4111-8111-111111111111');
    assert.equal(download.imageMode, 'download');
    assert.equal(download.includeImages, true, 'download 模式派生 includeImages=true');
    const off = await readJob('eeeeeeee-1111-4111-8111-111111111111');
    assert.equal(off.imageMode, 'off');
    assert.equal(off.includeImages, false, 'off 等价于旧 includeImages=false');
    const legacy = await readJob('ffffffff-1111-4111-8111-111111111111');
    assert.equal(legacy.imageMode, 'off', '非法 imageMode 回退到 includeImages 布尔迁移');
    const defaulted = await readJob('99999999-1111-4111-8111-111111111111');
    assert.equal(defaulted.imageMode, 'preview', '缺省按预览优先');
    assert.equal(defaulted.includeImages, true);

    // 等任务执行器收尾（异步写 jobs.json）再关服清理，避免 rm 与写盘竞争
    for (const id of ['dddddddd-1111-4111-8111-111111111111', 'eeeeeeee-1111-4111-8111-111111111111', 'ffffffff-1111-4111-8111-111111111111', '99999999-1111-4111-8111-111111111111']) {
      for (let i = 0; i < 100; i += 1) {
        const status = (await readJob(id)).status;
        if (status !== 'queued' && status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// 双 job 提交（#60/#65）：POST /v1/jobs 带 pdfSource 时同 attemptId 再落一条 pdf job，
// 响应带 pdfJob；GET /v1/jobs/:attemptId 返回该次尝试的全部 job；pdfSource 非法 400
test('POST /v1/jobs with pdfSource queues a second pdf job; GET returns both jobs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-server-pdf-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const code = 'pdf-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  const fakeLark = {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    validateDestination: async ({ nodeToken }) => ({ nodeToken, spaceId: 'space-1', title: '验收目录', objType: 'docx' }),
    run: async () => ({ ok: true, data: { document: { document_id: 'docx-1', url: 'https://example.feishu.cn/wiki/docx-1' } } }),
  };
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark,
    logger: { error() {}, log() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try {
    const paired = await (await call('/v1/pair', { method: 'POST', body: JSON.stringify({ code }) })).json();
    const auth = { Authorization: `Bearer ${paired.credential}` };
    const snapshot = { title: 'Attention Is All You Need', sourceUrl: 'https://arxiv.org/abs/1706.03762', capturedAt: new Date().toISOString(), markdown: '# 正文' };
    // 字面环回 IP：bridge 侧 SSRF 快速拒绝，pdf job 会落 failed——本测试只验证提交/查询形态
    const pdfSource = { type: 'url', url: 'http://127.0.0.1:9/paper.pdf', name: '1706.03762.pdf', sizeBytes: 2048 };

    const attemptId = '12121212-1212-4212-8212-121212121212';
    const submitted = await call('/v1/jobs', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ attemptId, destination: { nodeToken: 'wikcn-parent' }, includeImages: false, snapshot, pdfSource }),
    });
    assert.equal(submitted.status, 202);
    const accepted = await submitted.json();
    assert.equal(accepted.ok, true);
    assert.equal(accepted.job.kind ?? 'clip', 'clip');
    assert.equal(accepted.pdfJob.kind, 'pdf', '响应带第二条 pdf job');
    assert.equal(accepted.pdfJob.title, 'Attention Is All You Need');
    assert.equal(accepted.pdfJob.pdfSource.url, pdfSource.url);
    assert.equal(accepted.pdfJob.snapshot, undefined, 'pdf job 不携带正文快照');

    // 同 attemptId 重复提交（弹窗重试 PDF）：幂等，不产生第三条 job
    const again = await call('/v1/jobs', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ attemptId, destination: { nodeToken: 'wikcn-parent' }, includeImages: false, snapshot, pdfSource }),
    });
    assert.equal(again.status, 200, '幂等命中返回 200');

    const body = await (await call(`/v1/jobs/${attemptId}`, { headers: auth })).json();
    assert.equal(body.jobs.length, 2, '一次尝试返回全部 job');
    assert.deepEqual(body.jobs.map((job) => job.kind).sort(), ['clip', 'pdf']);
    assert.ok(!JSON.stringify(body).includes('# 正文'), '快照正文不得泄露');

    // 等两条 job 收尾再关服清理，避免执行器写盘与 rm 竞争
    for (let count = 0; count < 100; count += 1) {
      const current = await (await call(`/v1/jobs/${attemptId}`, { headers: auth })).json();
      if (current.jobs.every((job) => ['succeeded', 'succeeded_with_warnings', 'failed', 'needs_attention', 'expired', 'cancelled'].includes(job.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const settled = await (await call(`/v1/jobs/${attemptId}`, { headers: auth })).json();
    assert.equal(settled.jobs.find((job) => job.kind === 'clip').status, 'succeeded');
    assert.equal(settled.jobs.find((job) => job.kind === 'pdf').status, 'failed', '环回地址被 SSRF 拒绝，pdf 落 failed 而不拖垮 clip');

    // 非法 pdfSource 一律 400
    for (const bad of [
      { type: 'bytes', url: 'https://example.com/x.pdf' },
      { type: 'url', url: 'not-a-url' },
      { type: 'url', url: 'ftp://example.com/x.pdf' },
      { type: 'url', url: 'https://user:pass@example.com/x.pdf' },
      { type: 'url', url: 'https://example.com/x.pdf', sizeBytes: -1 },
    ]) {
      const rejected = await call('/v1/jobs', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ attemptId: '34343434-3434-4434-8434-343434343434', destination: { nodeToken: 'wikcn-parent' }, snapshot, pdfSource: bad }),
      });
      assert.equal(rejected.status, 400, `pdfSource=${JSON.stringify(bad)} 应被拒绝`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// pdf-only 提交（#67：PDF 标签页场景）：无 snapshot/destination 时只校验 pdfSource + 目录，
// 落一条 pdf job 并返回 { job: null, pdfJob }；clip 语义路径行为不变（由既有用例覆盖）
test('POST /v1/jobs pdf-only submission queues a single pdf job without snapshot/destination', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-server-pdfonly-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const code = 'pdf-only-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  let validated = 0;
  const fakeLark = {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    validateDestination: async () => { validated += 1; throw new Error('不应校验剪藏目标'); },
    run: async () => ({ ok: true, data: {} }),
  };
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark,
    logger: { error() {}, log() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try {
    const paired = await (await call('/v1/pair', { method: 'POST', body: JSON.stringify({ code }) })).json();
    const auth = { Authorization: `Bearer ${paired.credential}` };
    // 字面环回 IP：bridge 侧 SSRF 快速拒绝，pdf job 会落 failed——本测试只验证提交/查询形态
    const pdfSource = { type: 'url', url: 'http://127.0.0.1:9/paper.pdf', name: 'paper.pdf', sizeBytes: 2048 };
    const attemptId = '67676767-6767-4767-8767-676767676767';

    const submitted = await call('/v1/jobs', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ attemptId, pdfSource, pdfFolderToken: 'fld-papers', title: 'paper.pdf' }),
    });
    assert.equal(submitted.status, 202);
    const accepted = await submitted.json();
    assert.equal(accepted.job, null, 'pdf-only 提交不产生 clip job');
    assert.equal(accepted.pdfJob.kind, 'pdf');
    assert.equal(accepted.pdfJob.sourceUrl, pdfSource.url, 'sourceUrl 取 PDF 地址本身（弹窗同页恢复用）');
    assert.equal(accepted.pdfJob.folderToken, 'fld-papers');
    assert.equal(accepted.pdfJob.pdfSource.url, pdfSource.url);
    assert.equal(validated, 0, 'pdf-only 路径不校验剪藏目标');

    // 同 attemptId 重复提交：幂等，不产生第二条 job
    const again = await call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ attemptId, pdfSource }) });
    assert.equal(again.status, 200);

    const body = await (await call(`/v1/jobs/${attemptId}`, { headers: auth })).json();
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].kind, 'pdf');

    // 等任务收尾（SSRF 拒绝 → failed）再关服清理，避免执行器写盘与 rm 竞争
    for (let count = 0; count < 100; count += 1) {
      const current = await (await call(`/v1/jobs/${attemptId}`, { headers: auth })).json();
      if (current.jobs[0].status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // 缺 attemptId / 缺 pdfSource / 非法目录 token 一律 400
    assert.equal((await call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ pdfSource }) })).status, 400, '缺 attemptId');
    const noSource = await call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ attemptId: '78787878-7878-4878-8878-787878787878' }) });
    assert.equal(noSource.status, 400);
    assert.equal((await noSource.json()).code, 'PDF_SOURCE_REQUIRED');
    assert.equal((await call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ attemptId: '78787878-7878-4878-8878-787878787878', pdfSource, pdfFolderToken: 'bad token!' }) })).status, 400, '目录 token 非法');
    assert.equal((await call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ attemptId: '78787878-7878-4878-8878-787878787878', pdfSource: { type: 'url', url: 'ftp://example.com/x.pdf' } }) })).status, 400, 'pdfSource 校验与 clip 路径同一套');

    // AI 摘要（#75）：pdf-only 路径忽略 digest 字段，不校验 instruction、不产生 clip job
    const pdfDigest = await call('/v1/jobs', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ attemptId: '79797979-7979-4979-8979-797979797979', pdfSource, digest: { enabled: true } }),
    });
    assert.equal(pdfDigest.status, 202, 'pdf-only 忽略 digest');
    assert.equal((await pdfDigest.json()).job, null);
    for (let count = 0; count < 100; count += 1) {
      const current = await (await call('/v1/jobs/79797979-7979-4979-8979-797979797979', { headers: auth })).json();
      if (current.jobs[0].status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// ——— 分块通道与凭据回退（#68）———

const ATTEMPT_BYTES = '51515151-5151-4511-8511-515151515151';
const ATTEMPT_MISMATCH = '52525252-5252-4522-8522-525252525252';
const ATTEMPT_FALLBACK = '53535353-5353-4533-8533-535353535353';

async function bootBridge({ downloadPdf, uploads, sweepIntervalMs } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-server-chunks-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const code = 'chunks-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  const fakeLark = {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    validateDestination: async ({ nodeToken }) => ({ nodeToken, spaceId: 'space-1', title: '验收目录', objType: 'docx' }),
    uploadDriveFile: async (options) => { uploads?.push(options); return { fileToken: 'ft-x', url: 'https://example.feishu.cn/file/ft-x' }; },
    run: async () => ({ ok: true, data: {} }),
  };
  const { server, store } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json'), ...(sweepIntervalMs ? { sweepIntervalMs } : {}) },
    lark: fakeLark,
    logger: { error() {}, log() {} },
    ...(downloadPdf ? { downloadPdf } : {}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const paired = await (await raw('/v1/pair', { method: 'POST', body: JSON.stringify({ code }) })).json();
  const auth = { Authorization: `Bearer ${paired.credential}` };
  const call = (url, options = {}) => raw(url, { ...options, headers: { ...auth, ...(options.headers || {}) } });
  const readPdfJob = async (attemptId) => {
    const body = await (await call(`/v1/jobs/${attemptId}`)).json();
    return body.jobs?.find((job) => job.kind === 'pdf') ?? null;
  };
  const waitFor = async (attemptId, statuses) => {
    for (let count = 0; count < 200; count += 1) {
      const job = await readPdfJob(attemptId);
      if (statuses.includes(job?.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return readPdfJob(attemptId);
  };
  // complete/failed 落盘先于 executor finally 的 staging discard，等收尾完成再断言
  const waitStagingGone = async (attemptId) => {
    const stagingDir = path.join(directory, 'staging');
    for (let count = 0; count < 200; count += 1) {
      const left = (await readdir(stagingDir).catch(() => [])).filter((entry) => entry.startsWith(attemptId));
      if (left.length === 0) return [];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return (await readdir(stagingDir).catch(() => [])).filter((entry) => entry.startsWith(attemptId));
  };
  return { directory, server, store, call, readPdfJob, waitFor, waitStagingGone };
}

// cancel 路径 staging 清理（review #68）：cancel 无 HTTP 端点（store 层不碰文件系统），
// cancelled 的 pdf job 由周期 sweep 经 staging.discardForJob 即时清理，不等超龄孤儿兜底
test('cancelled 的 pdf job：未喂齐的 staging 由周期 sweep 即时清理', async () => {
  const attemptId = '54545454-5454-4544-8544-545454545454';
  const { directory, server, store, call, waitStagingGone } = await bootBridge({ sweepIntervalMs: 20 });
  const stagingDir = path.join(directory, 'staging');
  try {
    const sizeBytes = PDF_CHUNK_BYTES + 64;
    const submitted = await call('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ attemptId, pdfSource: { type: 'bytes', url: 'https://pub.example.com/c.pdf', name: 'c.pdf', sizeBytes, totalChunks: 2, sha256: 'b'.repeat(64) } }),
    });
    assert.equal(submitted.status, 202);
    // 喂一块（共两块，未齐）→ staging 落盘在 awaiting_bytes
    const fed = await call(`/v1/jobs/${attemptId}/pdf-chunks`, { method: 'POST', body: JSON.stringify({ index: 0, totalChunks: 2, dataBase64: randomBytes(PDF_CHUNK_BYTES).toString('base64') }) });
    assert.equal(fed.status, 200);
    assert.ok((await readdir(stagingDir)).some((entry) => entry.startsWith(attemptId)), 'staging 已落盘');

    const cancelled = await store.cancel(attemptId, 'pdf');
    assert.equal(cancelled.status, 'cancelled', 'awaiting_bytes 可直接取消');
    assert.deepEqual(await waitStagingGone(attemptId), [], 'cancelled 后 staging 由周期 sweep 即时清理');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('分块通道端到端：bytes 提交 → 位图续传 → 整验 → succeeded；hash 不匹配拒收', async () => {
  const uploads = [];
  const { directory, server, call, readPdfJob, waitFor, waitStagingGone } = await bootBridge({ uploads });
  const stagingDir = path.join(directory, 'staging');
  try {
    // 两块文件：一块整 4 MiB + 137 字节末块
    const tail = 137;
    const body = Buffer.concat([randomBytes(PDF_CHUNK_BYTES), randomBytes(tail)]);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const pdfSource = { type: 'bytes', url: 'https://pub.example.com/paper.pdf', name: 'paper.pdf', sizeBytes: body.length, totalChunks: 2, sha256 };

    const submitted = await call('/v1/jobs', { method: 'POST', body: JSON.stringify({ attemptId: ATTEMPT_BYTES, pdfSource, title: 'Paper' }) });
    assert.equal(submitted.status, 202);
    const accepted = await submitted.json();
    assert.equal(accepted.pdfJob.status, 'awaiting_bytes', 'bytes 型提交直接落 awaiting_bytes');
    assert.equal(accepted.pdfJob.pdfSource.sha256, sha256);

    // 位图初始为空；声明已就位
    const initial = await (await call(`/v1/jobs/${ATTEMPT_BYTES}/pdf-chunks`)).json();
    assert.deepEqual(initial, { ok: true, declared: true, totalChunks: 2, sizeBytes: body.length, bitmap: [] });

    // 非法块一律 400：index 越界 / totalChunks 不符 / 块大小不符
    const post = (payload) => call(`/v1/jobs/${ATTEMPT_BYTES}/pdf-chunks`, { method: 'POST', body: JSON.stringify(payload) });
    assert.equal((await post({ index: 2, totalChunks: 2, dataBase64: '' })).status, 400);
    assert.equal((await post({ index: 0, totalChunks: 3, dataBase64: '' })).status, 400);
    assert.equal((await post({ index: 1, totalChunks: 2, dataBase64: Buffer.alloc(10).toString('base64') })).status, 400, '末块必须恰为 137 字节');
    assert.equal((await post({ index: 0, totalChunks: 2, dataBase64: Buffer.alloc(10).toString('base64') })).status, 400, '非末块必须 4 MiB 满块');

    const first = await (await post({ index: 0, totalChunks: 2, dataBase64: body.subarray(0, PDF_CHUNK_BYTES).toString('base64') })).json();
    assert.deepEqual({ complete: first.complete, received: first.received }, { complete: false, received: 1 });
    // —— 模拟中断 —— 重连先查位图，只补缺块；重发已确认块幂等
    const resumed = await (await call(`/v1/jobs/${ATTEMPT_BYTES}/pdf-chunks`)).json();
    assert.deepEqual(resumed.bitmap, [0], '位图记录断点');
    const again = await (await post({ index: 0, totalChunks: 2, dataBase64: body.subarray(0, PDF_CHUNK_BYTES).toString('base64') })).json();
    assert.equal(again.received, 1, '重发已确认块幂等');
    const last = await (await post({ index: 1, totalChunks: 2, dataBase64: body.subarray(PDF_CHUNK_BYTES).toString('base64') })).json();
    assert.equal(last.complete, true, '末块到齐 + 整验通过');

    const done = await waitFor(ATTEMPT_BYTES, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.document.url, 'https://example.feishu.cn/file/ft-x');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].localFileName, 'Paper.pdf', '落盘文件名 = 标题渲染结果 + .pdf');
    assert.deepEqual(await waitStagingGone(ATTEMPT_BYTES), [], '终态后 staging 无残留');

    // hash 不匹配：拒收、job failed、staging 清理、不产生云盘文件
    const wrongSha = createHash('sha256').update(randomBytes(16)).digest('hex');
    const single = randomBytes(64);
    const mismatch = await call('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ attemptId: ATTEMPT_MISMATCH, pdfSource: { type: 'bytes', url: 'https://pub.example.com/bad.pdf', name: 'bad.pdf', sizeBytes: single.length, totalChunks: 1, sha256: wrongSha } }),
    });
    assert.equal(mismatch.status, 202);
    const rejected = await call(`/v1/jobs/${ATTEMPT_MISMATCH}/pdf-chunks`, { method: 'POST', body: JSON.stringify({ index: 0, totalChunks: 1, dataBase64: single.toString('base64') }) });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).code, 'PDF_HASH_MISMATCH');
    const failedJob = await readPdfJob(ATTEMPT_MISMATCH);
    assert.equal(failedJob.status, 'failed');
    assert.match(failedJob.error, /SHA-256/);
    assert.equal(uploads.length, 1, 'hash 不匹配不产生云盘文件');
    const afterMismatch = await readdir(stagingDir).catch(() => []);
    assert.deepEqual(afterMismatch.filter((entry) => entry.startsWith(ATTEMPT_MISMATCH)), [], '拒收后 staging 清理');

    // 非 awaiting_bytes 状态的 job 不接受分块端点
    assert.equal((await call(`/v1/jobs/${ATTEMPT_MISMATCH}/pdf-chunks`)).status, 409);
    assert.equal((await call(`/v1/jobs/${ATTEMPT_BYTES}/pdf-chunks`, { method: 'POST', body: JSON.stringify({ index: 0, totalChunks: 2, dataBase64: body.subarray(0, 4).toString('base64') }) })).status, 409, '已成功 job 不再收块');
    assert.equal((await call('/v1/jobs/99999999-9999-4999-8999-999999999999/pdf-chunks')).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('凭据回退全链路：url 型 403 → awaiting_bytes → 声明升级 → 分块喂入 → succeeded', async () => {
  const uploads = [];
  let downloads = 0;
  const downloadPdf = async () => {
    downloads += 1;
    throw Object.assign(new Error('PDF_HTTP_403'), { code: 'PDF_FETCH_FAILED', statusCode: 403 });
  };
  const { directory, server, call, readPdfJob, waitFor, waitStagingGone } = await bootBridge({ downloadPdf, uploads });
  try {
    const pdfUrl = 'https://pub.example.com/paywalled.pdf';
    const submitted = await call('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ attemptId: ATTEMPT_FALLBACK, pdfSource: { type: 'url', url: pdfUrl, name: 'paywalled.pdf' }, title: 'Paywalled Paper' }),
    });
    assert.equal(submitted.status, 202);

    // bridge 下载撞 403：不 fail，转 awaiting_bytes
    const awaiting = await waitFor(ATTEMPT_FALLBACK, ['awaiting_bytes', 'failed']);
    assert.equal(awaiting.status, 'awaiting_bytes');
    assert.equal(awaiting.error, null);
    assert.equal(downloads, 1);

    // 未补声明前：位图 declared=false；直接喂块 409
    const initial = await (await call(`/v1/jobs/${ATTEMPT_FALLBACK}/pdf-chunks`)).json();
    assert.equal(initial.declared, false, 'url 型回退尚未有 bytes 声明');
    assert.deepEqual(initial.bitmap, []);
    const early = await call(`/v1/jobs/${ATTEMPT_FALLBACK}/pdf-chunks`, { method: 'POST', body: JSON.stringify({ index: 0, totalChunks: 1, dataBase64: 'AA==' }) });
    assert.equal(early.status, 409);
    assert.equal((await early.json()).code, 'PDF_BYTES_NOT_DECLARED');

    // 扩展补交声明（同 url 升级）→ 分块喂入 → 整验通过 → executor 走 staging 上传
    const body = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), randomBytes(2048)]);
    const declaration = {
      type: 'bytes', url: pdfUrl, name: 'paywalled.pdf',
      sizeBytes: body.length, totalChunks: 1,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    const upgraded = await call('/v1/jobs', { method: 'POST', body: JSON.stringify({ attemptId: ATTEMPT_FALLBACK, pdfSource: declaration, title: 'Paywalled Paper' }) });
    assert.equal(upgraded.status, 200, '升级复用同一 job，不新建');
    const upgradedBody = await upgraded.json();
    assert.equal(upgradedBody.pdfJob.status, 'awaiting_bytes');
    assert.equal(upgradedBody.pdfJob.pdfSource.type, 'bytes');

    const fed = await call(`/v1/jobs/${ATTEMPT_FALLBACK}/pdf-chunks`, { method: 'POST', body: JSON.stringify({ index: 0, totalChunks: 1, dataBase64: body.toString('base64') }) });
    assert.equal((await fed.json()).complete, true);

    const done = await waitFor(ATTEMPT_FALLBACK, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded');
    assert.equal(downloads, 1, 'bytes 路径不再走 URL 下载');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].localFileName, 'Paywalled Paper.pdf', '落盘文件名仍取标题渲染结果');
    assert.deepEqual(await waitStagingGone(ATTEMPT_FALLBACK), [], '终态后 staging 无残留');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// ——— AI 摘要配置端点（#75）———

import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AiConfigStore } from '../src/bridge/ai-digest.mjs';

// 本地假 AI 服务：chat-completions 契约，按 Bearer key 决定 200/401
async function fakeAiServer(goodKey, reply = 'ok') {
  const aiServer = createHttpServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${goodKey}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
  });
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  return { server: aiServer, baseUrl: `http://127.0.0.1:${aiServer.address().port}/v1` };
}

test('AI provider 端点（#77）：列表/增改/改名/删除保护/key 不回显/测试连接按名解析', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-server-ai-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const aiFile = path.join(directory, 'ai.json');
  const code = 'ai-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  const ai = await fakeAiServer('sk-good');
  const fakeLark = {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    run: async () => ({ ok: true, data: {} }),
  };
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark,
    logger: { error() {}, log() {} },
    aiConfigStore: new AiConfigStore(aiFile),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try {
    const paired = await (await call('/v1/pair', { method: 'POST', body: JSON.stringify({ code }) })).json();
    const auth = { Authorization: `Bearer ${paired.credential}` };

    // 未配对一律 401
    assert.equal((await call('/v1/ai/providers')).status, 401);
    assert.equal((await call('/v1/ai/providers', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await call('/v1/ai/providers/delete', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await call('/v1/ai/test', { method: 'POST', body: '{}' })).status, 401);

    // 初始空列表
    assert.deepEqual(await (await call('/v1/ai/providers', { headers: auth })).json(), { ok: true, providers: [] });

    const post = (body) => call('/v1/ai/providers', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    // 校验 400 + 机器码：非法名 / 非法 apiType / 非 http(s) baseUrl / 空 model / 新建缺 key
    assert.equal((await (await post({ name: '', model: 'm', apiKey: 'k' })).json()).code, 'AI_PROVIDER_NAME_INVALID');
    assert.equal((await (await post({ name: '默认', apiType: 'gpt4', model: 'm', apiKey: 'k' })).json()).code, 'AI_TYPE_INVALID');
    assert.equal((await (await post({ name: '默认', apiType: 'responses', baseUrl: 'ftp://x', model: 'm', apiKey: 'k' })).json()).code, 'AI_BASE_URL_INVALID');
    assert.equal((await (await post({ name: '默认', apiType: 'responses', model: '', apiKey: 'k' })).json()).code, 'AI_MODEL_INVALID');
    assert.equal((await (await post({ name: '默认', apiType: 'responses', model: 'm' })).json()).code, 'AI_KEY_REQUIRED', '新建 provider apiKey 必填');
    // 测试连接：没有任何已存配置且未给全 → 400 AI_NOT_CONFIGURED
    const notConfigured = await call('/v1/ai/test', { method: 'POST', headers: auth, body: JSON.stringify({ apiType: 'chat-completions', model: 'm' }) });
    assert.equal(notConfigured.status, 400);
    assert.equal((await notConfigured.json()).code, 'AI_NOT_CONFIGURED');

    // 新建两套：默认 + ds；列表 sanitized 不回显 key，默认在前
    const saved = await post({ name: '默认', apiType: 'chat-completions', baseUrl: ai.baseUrl, model: 'fake-model', apiKey: 'sk-good' });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.deepEqual(savedBody.provider, { name: '默认', apiType: 'chat-completions', baseUrl: ai.baseUrl, model: 'fake-model', hasKey: true });
    assert.ok(!JSON.stringify(savedBody).includes('sk-good'), '保存响应不回显 key');
    await post({ name: 'ds', apiType: 'chat-completions', baseUrl: ai.baseUrl, model: 'fake-ds', apiKey: 'sk-good' });

    const listed = await (await call('/v1/ai/providers', { headers: auth })).json();
    assert.deepEqual(listed.providers.map((p) => p.name), ['默认', 'ds'], '列表默认在前');
    assert.ok(!JSON.stringify(listed).includes('sk-good'), 'GET 不回显 key');

    // 后续保存省略 apiKey = 保留该 provider 已存 key
    const kept = await post({ name: 'ds', apiType: 'chat-completions', baseUrl: ai.baseUrl, model: 'fake-ds-2' });
    assert.equal(kept.status, 200, '已有 key 时省略 apiKey 不再必填');
    assert.equal(JSON.parse(await readFile(aiFile, 'utf8')).providers.ds.apiKey, 'sk-good', '已存 key 保留');

    // 改名：ds → deepseek，key 搬走；「默认」不可改名/删除；改名目标已存在/来源不存在 → 400
    const renamed = await post({ name: 'deepseek', renameFrom: 'ds', apiType: 'chat-completions', baseUrl: ai.baseUrl, model: 'fake-ds-2' });
    assert.equal(renamed.status, 200);
    const afterRename = JSON.parse(await readFile(aiFile, 'utf8')).providers;
    assert.equal(afterRename.deepseek.apiKey, 'sk-good', '改名继承 key');
    assert.ok(!('ds' in afterRename), '旧名已删');
    assert.equal((await (await post({ name: 'xx', renameFrom: '默认', apiType: 'chat-completions', model: 'm', apiKey: 'k' })).json()).code, 'AI_PROVIDER_PROTECTED', '「默认」不可改名');
    assert.equal((await (await post({ name: '默认', renameFrom: 'deepseek', apiType: 'chat-completions', model: 'm' })).json()).code, 'AI_PROVIDER_EXISTS', '改名目标已存在');
    assert.equal((await (await post({ name: 'yy', renameFrom: 'ghost', apiType: 'chat-completions', model: 'm', apiKey: 'k' })).json()).code, 'AI_PROVIDER_NOT_FOUND', '改名来源不存在');

    // 删除：「默认」受保护；不存在 → 404 语义 400 + 机器码；删除 deepseek 成功
    const del = (body) => call('/v1/ai/providers/delete', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    assert.equal((await (await del({ name: '默认' })).json()).code, 'AI_PROVIDER_PROTECTED', '「默认」不可删除');
    assert.equal((await (await del({ name: 'ghost' })).json()).code, 'AI_PROVIDER_NOT_FOUND');
    assert.equal((await del({ name: 'deepseek' })).status, 200);
    assert.deepEqual((await (await call('/v1/ai/providers', { headers: auth })).json()).providers.map((p) => p.name), ['默认']);

    // 测试连接成功：不指定 name = 默认 provider；{ ok, latencyMs, reply }
    const tested = await (await call('/v1/ai/test', { method: 'POST', headers: auth, body: '{}' })).json();
    assert.equal(tested.ok, true);
    assert.equal(typeof tested.latencyMs, 'number');
    assert.equal(tested.reply, 'ok');

    // 指定 name 测试；name 不存在 → AI_PROVIDER_NOT_FOUND
    const named = await (await call('/v1/ai/test', { method: 'POST', headers: auth, body: JSON.stringify({ name: '默认' }) })).json();
    assert.equal(named.ok, true);
    assert.equal((await (await call('/v1/ai/test', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'ghost' }) })).json()).code, 'AI_PROVIDER_NOT_FOUND');

    // 逐项覆盖不落库：覆盖坏 key → ok:false AI_AUTH_FAILED；已存 key 不受影响
    const failed = await (await call('/v1/ai/test', { method: 'POST', headers: auth, body: JSON.stringify({ apiKey: 'sk-bad' }) })).json();
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'AI_AUTH_FAILED');
    assert.ok(failed.message, '失败带中文文案');
    assert.equal(JSON.parse(await readFile(aiFile, 'utf8')).providers['默认'].apiKey, 'sk-good', 'test 覆盖不写入配置');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => ai.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('POST /v1/jobs 的 digest 字段：enabled 时必须带非空 instruction ≤4000 字符，合法值随 job 落库', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-server-digest-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const code = 'digest-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  const fakeLark = {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    validateDestination: async ({ nodeToken }) => ({ nodeToken, spaceId: 'space-1', title: '验收目录', objType: 'docx' }),
    run: async () => ({ ok: true, data: { document: { document_id: 'docx-1', url: 'https://example.feishu.cn/wiki/docx-1' } } }),
  };
  // 不挂 aiConfigStore：bridge.json 缺 aiConfigFile 时 digest 开启的任务降级为警告（未配置 AI API），仍应成功
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark,
    logger: { error() {}, log() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try {
    const paired = await (await call('/v1/pair', { method: 'POST', body: JSON.stringify({ code }) })).json();
    const auth = { Authorization: `Bearer ${paired.credential}` };
    const snapshot = { title: '摘要网页', sourceUrl: 'https://example.com/digest', capturedAt: new Date().toISOString(), markdown: '# 正文' };
    const submit = (attemptId, digest) => call('/v1/jobs', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ attemptId, destination: { nodeToken: 'wikcn-parent' }, includeImages: false, snapshot, ...(digest !== undefined ? { digest } : {}) }),
    });
    const readClipJob = async (id) => {
      const body = await (await call(`/v1/jobs/${id}`, { headers: auth })).json();
      return body.jobs?.find((job) => job.kind === 'clip') ?? null;
    };

    // enabled===true 时：缺 instruction / 空串 / 超长 一律 400 DIGEST_INVALID
    for (const [index, digest] of [
      { enabled: true },
      { enabled: true, instruction: '' },
      { enabled: true, instruction: '   ' },
      { enabled: true, instruction: 'x'.repeat(4001) },
      { enabled: true, instruction: 42 },
      // provider（#78）：非字符串/空白/超长同样 DIGEST_INVALID
      { enabled: true, instruction: 'i', provider: 42 },
      { enabled: true, instruction: 'i', provider: '   ' },
      { enabled: true, instruction: 'i', provider: 'x'.repeat(65) },
    ].entries()) {
      const rejected = await submit(`8888888${index}-1111-4111-8111-111111111111`, digest);
      assert.equal(rejected.status, 400, `digest=${JSON.stringify(digest).slice(0, 60)} 应被拒绝`);
      assert.equal((await rejected.json()).code, 'DIGEST_INVALID');
    }

    // 合法 digest 随 job 落库；enabled:false 归一为 null
    const valid = await submit('81818181-1111-4111-8111-111111111111', { enabled: true, instruction: '总结成三点' });
    assert.equal(valid.status, 202);
    const off = await submit('82828282-1111-4111-8111-111111111111', { enabled: false });
    assert.equal(off.status, 202);
    // provider 指定但未配置任何 AI（本用例未挂 aiConfigStore）→ 悬空引用降级：warning 指明 provider 名
    const named = await submit('83838383-1111-4111-8111-111111111111', { enabled: true, instruction: '总结', provider: 'ds' });
    assert.equal(named.status, 202);

    // 等任务收尾再断言/清理：未配置 AI 时 digest 开启 → 降级警告，job 仍成功
    let digestJob;
    for (let count = 0; count < 100; count += 1) {
      digestJob = await readClipJob('81818181-1111-4111-8111-111111111111');
      if (digestJob && !['queued', 'running'].includes(digestJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(digestJob.digest, { enabled: true, instruction: '总结成三点' }, 'digest 随 job 落库');
    assert.equal(digestJob.status, 'succeeded_with_warnings', '未配置 AI 降级为部分成功');
    assert.ok(digestJob.warnings.some((warning) => warning.includes('AI 摘要生成失败：未配置 AI API')));
    assert.ok(digestJob.timeline.some((entry) => entry.kind === 'stage' && entry.name === 'digest'), 'timeline 含 digest 阶段');

    let offJob;
    for (let count = 0; count < 100; count += 1) {
      offJob = await readClipJob('82828282-1111-4111-8111-111111111111');
      if (offJob && !['queued', 'running'].includes(offJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(offJob.digest, null, 'enabled:false 归一为 null');
    assert.equal(offJob.status, 'succeeded');

    // 悬空 provider（#78）：digest.provider 随 job 落库；bridge 无此 provider → 剪藏成功 +
    // warning 指明 provider 名（可能已被删除），不算 job 失败
    let namedJob;
    for (let count = 0; count < 100; count += 1) {
      namedJob = await readClipJob('83838383-1111-4111-8111-111111111111');
      if (namedJob && !['queued', 'running'].includes(namedJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(namedJob.digest.provider, 'ds', 'provider 随 job 落库');
    assert.equal(namedJob.status, 'succeeded_with_warnings', '悬空 provider 降级为部分成功');
    assert.ok(namedJob.warnings.some((warning) => warning.includes('「ds」不存在')), 'warning 指明 provider 名');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('两套模板分选不同 provider（#78 验收）：摘要分别来自所选 provider，互不串台', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-server-e2e-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const aiFile = path.join(directory, 'ai.json');
  const code = 'e2e-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  // 两个假 AI 服务：默认 provider 与 ds 各一台，key 与回复内容都不同
  const aiDefault = await fakeAiServer('sk-main', 'DEFAULT-摘要');
  const aiDs = await fakeAiServer('sk-ds', 'DS-摘要');
  // 假 lark：建文档时按标题捕获写入的正文（content.md），供断言摘要来源
  const contents = new Map();
  const fakeLark = {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    validateDestination: async ({ nodeToken }) => ({ nodeToken, spaceId: 'space-1', title: '验收目录', objType: 'docx' }),
    run: async (args, options = {}) => {
      if (args.includes('@content.md')) {
        const title = args[args.indexOf('--title') + 1];
        contents.set(title, await readFile(path.join(options.cwd, 'content.md'), 'utf8'));
      }
      return { ok: true, data: { document: { document_id: 'docx-1', url: 'https://example.feishu.cn/wiki/docx-1' } } };
    },
  };
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark,
    logger: { error() {}, log() {} },
    aiConfigStore: new AiConfigStore(aiFile),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try {
    const paired = await (await call('/v1/pair', { method: 'POST', body: JSON.stringify({ code }) })).json();
    const auth = { Authorization: `Bearer ${paired.credential}` };
    // 建两套 provider：默认 → aiDefault，ds → aiDs
    const save = (body) => call('/v1/ai/providers', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    assert.equal((await save({ name: '默认', apiType: 'chat-completions', baseUrl: aiDefault.baseUrl, model: 'fake', apiKey: 'sk-main' })).status, 200);
    assert.equal((await save({ name: 'ds', apiType: 'chat-completions', baseUrl: aiDs.baseUrl, model: 'fake', apiKey: 'sk-ds' })).status, 200);

    const submit = (attemptId, title, digest) => call('/v1/jobs', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        attemptId, destination: { nodeToken: 'wikcn-parent' }, includeImages: false,
        snapshot: { title, sourceUrl: 'https://example.com/e2e', capturedAt: new Date().toISOString(), markdown: '# 正文' },
        digest,
      }),
    });
    const defaultJob = await submit('84848484-1111-4111-8111-111111111111', '主摘要页', { enabled: true, instruction: 'i' });
    assert.equal(defaultJob.status, 202);
    const dsJob = await submit('85858585-1111-4111-8111-111111111111', 'DS 摘要页', { enabled: true, instruction: 'i', provider: 'ds' });
    assert.equal(dsJob.status, 202);

    const waitClip = async (id) => {
      for (let count = 0; count < 100; count += 1) {
        const body = await (await call(`/v1/jobs/${id}`, { headers: auth })).json();
        const job = body.jobs?.find((entry) => entry.kind === 'clip');
        if (job && !['queued', 'running'].includes(job.status)) return job;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return null;
    };
    const doneDefault = await waitClip('84848484-1111-4111-8111-111111111111');
    const doneDs = await waitClip('85858585-1111-4111-8111-111111111111');
    assert.equal(doneDefault?.status, 'succeeded');
    assert.equal(doneDs?.status, 'succeeded');
    assert.deepEqual(doneDefault?.warnings ?? [], [], '默认 provider 无警告');
    assert.deepEqual(doneDs?.warnings ?? [], [], 'ds provider 无警告');
    assert.ok(contents.get('主摘要页')?.includes('DEFAULT-摘要'), '未指定 provider 的剪藏走默认 provider');
    assert.ok(contents.get('DS 摘要页')?.includes('DS-摘要'), '指定 ds 的剪藏走 ds provider');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => aiDefault.server.close(resolve));
    await new Promise((resolve) => aiDs.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
