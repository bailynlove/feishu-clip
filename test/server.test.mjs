import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBridge } from '../src/bridge/server.mjs';

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
      job = (await (await call(`/v1/jobs/${attemptId}`, { headers: { Authorization: `Bearer ${paired.credential}` } })).json()).job;
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
    const readJob = async (id) => (await (await call(`/v1/jobs/${id}`, { headers: auth })).json()).job;

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
