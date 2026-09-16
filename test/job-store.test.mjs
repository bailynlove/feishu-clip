import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PersistentJobStore } from '../src/bridge/job-store.mjs';

async function withStore(run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-job-store-'));
  const filePath = path.join(directory, 'jobs.json');
  const store = new PersistentJobStore({ filePath, ...options });
  try {
    await run({ store, filePath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('technical retries reuse an attempt while a new click on the same URL creates a new job', async () => {
  await withStore(async ({ store, filePath }) => {
    const first = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    const retry = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    const secondClick = await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/article' });

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.job.jobId, first.job.jobId);
    assert.equal(secondClick.created, true);
    assert.notEqual(secondClick.job.jobId, first.job.jobId);
    assert.deepEqual((await store.list()).map((job) => job.attemptId), ['attempt-1', 'attempt-2']);

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(persisted.jobs.length, 2);
  });
});

test('an expired worker lease is recovered from disk and can be claimed after restart', async () => {
  let now = 1_000;
  await withStore(async ({ store, filePath }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    const claimed = await store.claim('attempt-1', 'worker-a');
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.leaseExpiresAt, 61_000);

    now = 30_000;
    const heartbeat = await store.heartbeat('attempt-1', 'worker-a');
    assert.equal(heartbeat.leaseExpiresAt, 90_000);

    now = 90_001;
    const restartedStore = new PersistentJobStore({ filePath, now: () => now, leaseMs: 60_000 });
    const recovered = await restartedStore.recoverExpired();
    assert.deepEqual(recovered.requeued, ['attempt-1']);

    const queued = await restartedStore.get('attempt-1', 'clip');
    assert.equal(queued.status, 'queued');
    assert.equal(queued.retryCount, 1);
    assert.equal(queued.workerId, null);

    const reclaimed = await restartedStore.claim('attempt-1', 'worker-b');
    assert.equal(reclaimed.status, 'running');
    assert.equal(reclaimed.workerId, 'worker-b');
  }, { now: () => now, leaseMs: 60_000 });
});

test('a crash during document creation reconciles before another create attempt', async () => {
  let now = 1_000;
  await withStore(async ({ store, filePath }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    await store.claim('attempt-1', 'worker-a');
    await store.beginCreate('attempt-1', 'worker-a');

    now = 61_001;
    const restartedStore = new PersistentJobStore({ filePath, now: () => now, leaseMs: 60_000 });
    const recovered = await restartedStore.recoverExpired();
    assert.deepEqual(recovered.requeued, []);
    assert.deepEqual(recovered.reconciling, ['attempt-1']);
    assert.equal((await restartedStore.get('attempt-1', 'clip')).status, 'reconciling');

    const confirmedAbsent = await restartedStore.resolveAmbiguousCreate('attempt-1', { document: null });
    assert.equal(confirmedAbsent.status, 'queued');
    assert.equal(confirmedAbsent.step, 'create_document');
  }, { now: () => now, leaseMs: 60_000 });
});

test('document outcomes require a persisted begin-create barrier', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    await store.claim('attempt-1', 'worker-a');
    await assert.rejects(
      () => store.recordDocument('attempt-1', 'worker-a', {
        documentId: 'docx-untracked',
        url: 'https://example.test/docx-untracked',
      }),
      /beginCreate/,
    );
    await assert.rejects(
      () => store.markCreateAmbiguous('attempt-1', 'worker-a'),
      /beginCreate/,
    );
  });
});

test('reconciliation rejects a document without an identity and usable URL', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    await store.claim('attempt-1', 'worker-a');
    await store.beginCreate('attempt-1', 'worker-a');
    await store.markCreateAmbiguous('attempt-1', 'worker-a');

    await assert.rejects(
      () => store.resolveAmbiguousCreate('attempt-1', { document: {} }),
      /documentId and url/,
    );
    assert.equal((await store.get('attempt-1', 'clip')).status, 'reconciling');
  });
});

test('an ambiguous create timeout blocks retries until reconciliation chooses the next step', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-found', sourceUrl: 'https://example.test/found' });
    await store.claim('attempt-found', 'worker-a');
    await store.beginCreate('attempt-found', 'worker-a');
    const ambiguous = await store.markCreateAmbiguous('attempt-found', 'worker-a');
    assert.equal(ambiguous.status, 'reconciling');
    assert.equal(ambiguous.step, 'create_document');
    await assert.rejects(() => store.claim('attempt-found', 'worker-b'), /reconciling/);

    const recovery = await store.recoverExpired();
    assert.deepEqual(recovery.requeued, []);

    const found = await store.resolveAmbiguousCreate('attempt-found', {
      document: { documentId: 'docx-found', url: 'https://example.test/docx-found' },
    });
    assert.equal(found.status, 'queued');
    assert.equal(found.step, 'write_body');
    assert.equal(found.document.documentId, 'docx-found');

    await store.submit({ attemptId: 'attempt-absent', sourceUrl: 'https://example.test/absent' });
    await store.claim('attempt-absent', 'worker-a');
    await store.beginCreate('attempt-absent', 'worker-a');
    await store.markCreateAmbiguous('attempt-absent', 'worker-a');
    const absent = await store.resolveAmbiguousCreate('attempt-absent', { document: null });
    assert.equal(absent.status, 'queued');
    assert.equal(absent.step, 'create_document');
    assert.equal(absent.document, null);
  });
});

test('cancellation preserves a document that was already created', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'before-create', sourceUrl: 'https://example.test/before' });
    const beforeCreate = await store.cancel('before-create');
    assert.equal(beforeCreate.status, 'cancelled');
    assert.equal(beforeCreate.document, null);
    await assert.rejects(() => store.claim('before-create', 'worker-a'), /cancelled/);

    await store.submit({ attemptId: 'after-create', sourceUrl: 'https://example.test/after' });
    await store.claim('after-create', 'worker-a');
    await store.beginCreate('after-create', 'worker-a');
    await store.recordDocument('after-create', 'worker-a', {
      documentId: 'docx-after',
      url: 'https://example.test/docx-after',
    });
    const afterCreate = await store.cancel('after-create');
    assert.equal(afterCreate.status, 'cancelled_with_document');
    assert.equal(afterCreate.document.url, 'https://example.test/docx-after');
    assert.equal(afterCreate.workerId, null);
  });
});

test('terminal outcomes preserve useful documents and surface failed orphan cleanup', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'complete', sourceUrl: 'https://example.test/complete' });
    await store.claim('complete', 'worker-a');
    await store.beginCreate('complete', 'worker-a');
    await store.recordDocument('complete', 'worker-a', {
      documentId: 'docx-complete',
      url: 'https://example.test/docx-complete',
    });
    assert.equal((await store.complete('complete', 'worker-a')).status, 'succeeded');

    await store.submit({ attemptId: 'image-failure', sourceUrl: 'https://example.test/images' });
    await store.claim('image-failure', 'worker-a');
    await store.beginCreate('image-failure', 'worker-a');
    await store.recordDocument('image-failure', 'worker-a', {
      documentId: 'docx-images',
      url: 'https://example.test/docx-images',
    });
    const partial = await store.fail('image-failure', 'worker-a', {
      stage: 'images',
      error: 'one image could not be uploaded',
    });
    assert.equal(partial.status, 'succeeded_with_warnings');
    assert.equal(partial.document.documentId, 'docx-images');
    assert.deepEqual(partial.warnings, ['one image could not be uploaded']);

    await store.submit({ attemptId: 'cleanup-worked', sourceUrl: 'https://example.test/cleanup-worked' });
    await store.claim('cleanup-worked', 'worker-a');
    await store.beginCreate('cleanup-worked', 'worker-a');
    await store.recordDocument('cleanup-worked', 'worker-a', {
      documentId: 'docx-deleted',
      url: 'https://example.test/docx-deleted',
    });
    const cleaned = await store.fail('cleanup-worked', 'worker-a', {
      stage: 'body',
      error: 'body import failed',
      cleanup: { status: 'deleted' },
    });
    assert.equal(cleaned.status, 'failed');
    assert.equal(cleaned.document, null);

    await store.submit({ attemptId: 'cleanup-failed', sourceUrl: 'https://example.test/cleanup-failed' });
    await store.claim('cleanup-failed', 'worker-a');
    await store.beginCreate('cleanup-failed', 'worker-a');
    await store.recordDocument('cleanup-failed', 'worker-a', {
      documentId: 'docx-orphan',
      url: 'https://example.test/docx-orphan',
    });
    const orphan = await store.fail('cleanup-failed', 'worker-a', {
      stage: 'body',
      error: 'body import failed',
      cleanup: { status: 'failed', error: 'delete timed out' },
    });
    assert.equal(orphan.status, 'needs_attention');
    assert.equal(orphan.document.url, 'https://example.test/docx-orphan');
    assert.equal(orphan.cleanup.error, 'delete timed out');
  });
});

test('stale jobs expire safely while document-bearing or ambiguous jobs require attention', async () => {
  let now = 0;
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'plain-stale', sourceUrl: 'https://example.test/plain' });

    await store.submit({ attemptId: 'document-stale', sourceUrl: 'https://example.test/document' });
    await store.claim('document-stale', 'worker-a');
    await store.beginCreate('document-stale', 'worker-a');
    await store.markCreateAmbiguous('document-stale', 'worker-a');
    await store.resolveAmbiguousCreate('document-stale', {
      document: { documentId: 'docx-stale', url: 'https://example.test/docx-stale' },
    });

    await store.submit({ attemptId: 'ambiguous-stale', sourceUrl: 'https://example.test/ambiguous' });
    await store.claim('ambiguous-stale', 'worker-a');
    await store.beginCreate('ambiguous-stale', 'worker-a');
    await store.markCreateAmbiguous('ambiguous-stale', 'worker-a');

    now = 10_001;
    const recovered = await store.recoverExpired();
    assert.deepEqual(recovered.expired, ['plain-stale']);
    assert.deepEqual(recovered.needsAttention, ['document-stale', 'ambiguous-stale']);

    const visible = await store.list({ statuses: ['expired', 'needs_attention'] });
    assert.deepEqual(visible.map((job) => [job.attemptId, job.status]), [
      ['plain-stale', 'expired'],
      ['document-stale', 'needs_attention'],
      ['ambiguous-stale', 'needs_attention'],
    ]);
  }, { now: () => now, jobTtlMs: 10_000 });
});

test('cancelling an ambiguous create waits for reconciliation before declaring the outcome', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    await store.claim('attempt-1', 'worker-a');
    await store.beginCreate('attempt-1', 'worker-a');
    await store.markCreateAmbiguous('attempt-1', 'worker-a');

    const pending = await store.cancel('attempt-1');
    assert.equal(pending.status, 'cancel_pending_reconciliation');

    const resolved = await store.resolveAmbiguousCreate('attempt-1', {
      document: { documentId: 'docx-late', url: 'https://example.test/docx-late' },
    });
    assert.equal(resolved.status, 'cancelled_with_document');
    assert.equal(resolved.document.documentId, 'docx-late');
    assert.equal(resolved.step, 'done');
  });
});

test('cancelling while the create request is in flight still requires reconciliation', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    await store.claim('attempt-1', 'worker-a');
    await store.beginCreate('attempt-1', 'worker-a');

    const pending = await store.cancel('attempt-1');
    assert.equal(pending.status, 'cancel_pending_reconciliation');
    assert.equal(pending.workerId, null);

    const resolved = await store.resolveAmbiguousCreate('attempt-1', {
      document: { documentId: 'docx-created', url: 'https://example.test/docx-created' },
    });
    assert.equal(resolved.status, 'cancelled_with_document');
    assert.equal(resolved.document.url, 'https://example.test/docx-created');
  });
});

test('unsupported protocol strings are rejected without mutating the job', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    await assert.rejects(() => store.list({ statuses: ['queueed'] }), /Unknown job status/);

    await store.claim('attempt-1', 'worker-a');
    await assert.rejects(
      () => store.fail('attempt-1', 'worker-a', { stage: 'thumbnail', error: 'failed' }),
      /Unknown failure stage/,
    );
    assert.equal((await store.get('attempt-1', 'clip')).status, 'running');
  });
});

test('clientTiming is persisted on submit and defaults to null', async () => {
  await withStore(async ({ store }) => {
    const withTiming = await store.submit({
      attemptId: 'attempt-1',
      sourceUrl: 'https://example.test/article',
      clientTiming: { extractMs: 123 },
    });
    assert.deepEqual(withTiming.job.clientTiming, { extractMs: 123 });

    const without = await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/other' });
    assert.equal(without.job.clientTiming, null);
    assert.deepEqual((await store.get('attempt-1', 'clip')).clientTiming, { extractMs: 123 });
  });
});

test('complete and fail persist timeline and totalMs; old job files read with defaults', async () => {
  await withStore(async ({ store, filePath }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    await store.claim('attempt-1', 'worker-a');
    await store.beginCreate('attempt-1', 'worker-a');
    await store.recordDocument('attempt-1', 'worker-a', { documentId: 'docx-1', url: 'https://example.test/docx-1' });
    const timeline = [
      { kind: 'cli', name: 'docs +create', ms: 1200 },
      { kind: 'stage', name: 'create_document', ms: 1500 },
      { kind: 'image', name: 'image-1', ms: 800, detail: '失败消息' },
    ];
    const done = await store.complete('attempt-1', 'worker-a', { warnings: [], timeline, totalMs: 9300 });
    assert.deepEqual(done.timeline, timeline);
    assert.equal(done.totalMs, 9300);

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(persisted.jobs[0].timeline, timeline);
    assert.equal(persisted.jobs[0].totalMs, 9300);

    await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/fail' });
    await store.claim('attempt-2', 'worker-a');
    const failed = await store.fail('attempt-2', 'worker-a', { stage: 'create_document', error: 'boom', timeline: [], totalMs: 50 });
    assert.deepEqual(failed.timeline, []);
    assert.equal(failed.totalMs, 50);

    // 终态不带耗时字段时按缺省落盘
    await store.submit({ attemptId: 'attempt-3', sourceUrl: 'https://example.test/plain' });
    await store.claim('attempt-3', 'worker-a');
    await store.beginCreate('attempt-3', 'worker-a');
    await store.recordDocument('attempt-3', 'worker-a', { documentId: 'docx-3', url: 'https://example.test/docx-3' });
    const plain = await store.complete('attempt-3', 'worker-a');
    assert.deepEqual(plain.timeline, []);
    assert.equal(plain.totalMs, null);

    // 老 job 文件没有这些字段，读取侧补缺省值
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    for (const job of data.jobs) {
      delete job.timeline;
      delete job.totalMs;
      delete job.clientTiming;
    }
    await writeFile(filePath, JSON.stringify(data));
    const legacy = await store.get('attempt-1', 'clip');
    assert.deepEqual(legacy.timeline, []);
    assert.equal(legacy.totalMs, null);
    assert.equal(legacy.clientTiming, null);
  });
});

// ——— 双 job 模型（#60/#65）：幂等键 (attemptId, kind)，pdf 用最小状态集 ———

const PDF_SOURCE = { type: 'url', url: 'https://arxiv.org/pdf/2401.00001', name: '2401.00001.pdf', sizeBytes: 12345 };

test('同一 attemptId 下 clip 与 pdf job 各自独立，get 不带 kind 返回全部', async () => {
  await withStore(async ({ store }) => {
    const clip = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    const pdf = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article', kind: 'pdf', pdfSource: PDF_SOURCE, title: '论文标题' });

    assert.equal(clip.created, true);
    assert.equal(pdf.created, true);
    assert.notEqual(pdf.job.jobId, clip.job.jobId);
    assert.equal(pdf.job.kind, 'pdf');
    assert.equal(clip.job.kind, 'clip');
    assert.equal(pdf.job.title, '论文标题');
    assert.deepEqual(pdf.job.pdfSource, PDF_SOURCE);
    assert.equal(pdf.job.snapshot, null, 'pdf job 不携带正文快照');

    const all = await store.get('attempt-1');
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((job) => job.kind).sort(), ['clip', 'pdf']);
    assert.equal((await store.get('attempt-1', 'clip')).jobId, clip.job.jobId);
    assert.equal((await store.get('attempt-1', 'pdf')).jobId, pdf.job.jobId);
    assert.deepEqual(await store.get('attempt-unknown'), [], '未知 attempt 返回空数组');
    assert.equal(await store.get('attempt-1', 'nope'), null);

    // 同 kind 重复提交幂等命中，不新增 job；clip 与 pdf 互不干扰
    const againClip = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    const againPdf = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article', kind: 'pdf', pdfSource: PDF_SOURCE });
    assert.equal(againClip.created, false);
    assert.equal(againPdf.created, false);
    assert.equal((await store.list()).length, 2);
  });
});

test('pdf job 提交校验：url/bytes 两型，http(s) 无凭据；bytes 声明必填且自洽', async () => {
  await withStore(async ({ store }) => {
    const submit = (pdfSource) => store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource });
    await assert.rejects(() => submit(null), /pdfSource.type/);
    await assert.rejects(() => submit({ type: 'url', url: 'not-a-url' }), /valid URL/);
    await assert.rejects(() => submit({ type: 'url', url: 'ftp://example.test/x.pdf' }), /credential-free/);
    await assert.rejects(() => submit({ type: 'url', url: 'https://user:pass@example.test/x.pdf' }), /credential-free/);
    // 校验实现与 server 共享（review 起单份）：name 超长两层的口径一致——严格拒绝而非截断
    await assert.rejects(() => submit({ type: 'url', url: 'https://example.test/x.pdf', name: 'x'.repeat(251) }), /at most 250 chars/);
    const ok = await submit({ type: 'url', url: 'https://example.test/x.pdf', name: 'x'.repeat(250), sizeBytes: 42 });
    assert.equal(ok.job.pdfSource.name.length, 250, '250 字符的 name 合法');
    assert.equal(ok.job.pdfSource.sizeBytes, 42);

    // bytes 型（#68）：文件名/总大小/总块数/SHA-256 必填，totalChunks 必须按 4 MiB 口径自洽
    const submitBytes = (pdfSource) => store.submit({ attemptId: 'attempt-bytes', sourceUrl: 'https://example.test/b', kind: 'pdf', pdfSource });
    const bytes = { type: 'bytes', url: 'https://example.test/x.pdf', name: 'x.pdf', sizeBytes: 5 * 1024 * 1024, totalChunks: 2, sha256: 'a'.repeat(64) };
    await assert.rejects(() => submitBytes({ type: 'bytes', url: 'https://example.test/x.pdf' }), /name is required/);
    await assert.rejects(() => submitBytes({ ...bytes, totalChunks: 3 }), /totalChunks does not match/);
    await assert.rejects(() => submitBytes({ ...bytes, sha256: 'A'.repeat(64) }), /sha256 must be 64 lowercase hex/);
    await assert.rejects(() => submitBytes({ ...bytes, url: 'ftp://example.test/x.pdf' }), /credential-free/);
    await assert.rejects(() => submitBytes({ ...bytes, sizeBytes: 0 }), /sizeBytes must be a positive integer/);
    const accepted = await submitBytes(bytes);
    assert.equal(accepted.job.status, 'awaiting_bytes', 'bytes 型提交直接落 awaiting_bytes');
    assert.deepEqual(accepted.job.pdfSource, bytes, '声明随 job 落库（url 保留为抓取地址与绑定键）');
  });
});

test('pdf job 状态机：claim → complete 要求 document.url；fail 直接 failed 无 reconciling/needs_attention', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    const claimed = await store.claim('attempt-1', 'worker-a', 'pdf');
    assert.equal(claimed.status, 'running');

    await assert.rejects(
      () => store.complete('attempt-1', 'worker-a', {}, 'pdf'),
      /pdf job completion requires/,
      'pdf complete 必须带上传产物 url',
    );

    const done = await store.complete('attempt-1', 'worker-a', { document: { fileToken: 'ft1', url: 'https://example.feishu.cn/file/ft1' } }, 'pdf');
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.document, { fileToken: 'ft1', url: 'https://example.feishu.cn/file/ft1' });

    await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b', kind: 'pdf', pdfSource: PDF_SOURCE });
    await store.claim('attempt-2', 'worker-a', 'pdf');
    const failed = await store.fail('attempt-2', 'worker-a', { stage: 'pdf', error: '下载超时' }, 'pdf');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, '下载超时');
    assert.equal(failed.document, null, 'pdf 失败不留半成品状态');
  });
});

test('pdf job 取消走最小状态集：queued/running → cancelled', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    assert.equal((await store.cancel('attempt-1', 'pdf')).status, 'cancelled');

    await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b', kind: 'pdf', pdfSource: PDF_SOURCE });
    await store.claim('attempt-2', 'worker-a', 'pdf');
    assert.equal((await store.cancel('attempt-2', 'pdf')).status, 'cancelled');
    // clip 的取消语义不受 pdf 影响：clip 终态重发不复活，pdf failed 重发会重排（见下）
  });
});

// ——— PDF 云盘引用回填（#88）：clip job 记 pdfRefInserted 幂等标记，pdf job 重试/重跑不重复插入 ———

test('pdfRefInserted（#88）：clip job 缺省 false；markPdfRefInserted 置位/清除且幂等；claimed 标明本调用是否完成置位；存量 job 读取补 false', async () => {
  await withStore(async ({ store, filePath }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a' });
    assert.equal((await store.get('attempt-1', 'clip')).pdfRefInserted, false, '新建 clip job 缺省未插引用');

    // mark-before-insert（#88 review）：先置位再插入，claimed=true 标明本调用完成了
    // false→true 的跃迁（租约重排竞态下只有一个执行体能拿到 true）
    const marked = await store.markPdfRefInserted('attempt-1');
    assert.equal(marked.job.pdfRefInserted, true);
    assert.equal(marked.claimed, true, '首次置位 claimed=true');
    const again = await store.markPdfRefInserted('attempt-1');
    assert.equal(again.job.pdfRefInserted, true, '重复标记幂等');
    assert.equal(again.claimed, false, '已被置位时 claimed=false（另一执行体据此跳过不双插）');
    assert.equal((await store.get('attempt-1', 'clip')).pdfRefInserted, true, '标记随 jobs.json 落盘');

    // 反向置位：插入失败后清除标记，重试可补插；清除后可再次置位
    const cleared = await store.markPdfRefInserted('attempt-1', false);
    assert.equal(cleared.job.pdfRefInserted, false);
    assert.equal(cleared.claimed, false, '清除不是置位，claimed=false');
    assert.equal((await store.get('attempt-1', 'clip')).pdfRefInserted, false, '清除随 jobs.json 落盘');
    const remark = await store.markPdfRefInserted('attempt-1');
    assert.equal(remark.claimed, true, '清除后可再次置位');

    await assert.rejects(() => store.markPdfRefInserted('attempt-unknown'), /Unknown attemptId/);

    // 存量 job 文件没有该字段：读取侧补 false
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    delete persisted.jobs[0].pdfRefInserted;
    await writeFile(filePath, JSON.stringify(persisted));
    const reloaded = new PersistentJobStore({ filePath });
    assert.equal((await reloaded.get('attempt-1', 'clip')).pdfRefInserted, false);
  });
});

test('pdf job complete 可携带警告（#88 引用插入失败）：warnings 落库，状态仍 succeeded', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    await store.claim('attempt-1', 'worker-a', 'pdf');
    const done = await store.complete('attempt-1', 'worker-a', {
      document: { fileToken: 'ft1', url: 'https://example.feishu.cn/file/ft1' },
      warnings: ['PDF 云盘引用插入失败：docx api 999'],
    }, 'pdf');
    assert.equal(done.status, 'succeeded', '引用插入失败不改变 pdf job 的成功终态');
    assert.deepEqual(done.warnings, ['PDF 云盘引用插入失败：docx api 999']);
  });
});

test('pdf job 记录目标目录 folderToken（#66）：缺省 null（根目录），重试以最新提交为准', async () => {
  await withStore(async ({ store }) => {
    const legacy = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    assert.equal(legacy.job.folderToken, null, '不带 folderToken 的提交落根目录');

    const picked = await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b', kind: 'pdf', pdfSource: PDF_SOURCE, folderToken: 'fld-a' });
    assert.equal(picked.job.folderToken, 'fld-a');

    // 非字符串/空串一律归一为 null
    const blank = await store.submit({ attemptId: 'attempt-3', sourceUrl: 'https://example.test/c', kind: 'pdf', pdfSource: PDF_SOURCE, folderToken: '' });
    assert.equal(blank.job.folderToken, null);

    // 失败重试（弹窗重选目录后点「重试 PDF」）：folderToken 以本次提交为准
    await store.claim('attempt-2', 'worker-a', 'pdf');
    await store.fail('attempt-2', 'worker-a', { stage: 'pdf', error: '目录已删除' }, 'pdf');
    const retried = await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b', kind: 'pdf', pdfSource: PDF_SOURCE, folderToken: 'fld-b' });
    assert.equal(retried.retried, true);
    assert.equal(retried.job.folderToken, 'fld-b', '重试带上重选的目录');

    // 持久化往返：folderToken 随 jobs.json 落盘
    const reloaded = await store.get('attempt-2', 'pdf');
    assert.equal(reloaded.folderToken, 'fld-b');
  });
});

test('failed 的 pdf job 同键重提交复位重排队（弹窗「重试 PDF」），clip 终态重发不复活', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    await store.claim('attempt-1', 'worker-a', 'pdf');
    await store.fail('attempt-1', 'worker-a', { stage: 'pdf', error: 'boom' }, 'pdf');

    const retried = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    assert.equal(retried.created, false);
    assert.equal(retried.retried, true, 'failed pdf 重提交应标记复位重排');
    assert.equal(retried.job.status, 'queued');
    assert.equal(retried.job.error, null);
    assert.equal(retried.job.retryCount, 1);
    assert.equal((await store.list()).length, 1, '复用同一 job 记录，不新增');

    // pdfSource 换了 URL 不复活：绑定冲突直接报错
    await store.fail('attempt-1', ...(await store.claim('attempt-1', 'worker-b', 'pdf'), ['worker-b', { stage: 'pdf', error: 'boom' }]), 'pdf');
    await assert.rejects(
      () => store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: { type: 'url', url: 'https://example.test/other.pdf' } }),
      /another pdf source/,
    );

    // clip 对照组：failed 的 clip 重发不复活
    await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b' });
    await store.claim('attempt-2', 'worker-a', 'clip');
    await store.fail('attempt-2', 'worker-a', { stage: 'create_document', error: 'boom' }, 'clip');
    const clipRetry = await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b' });
    assert.equal(clipRetry.created, false);
    assert.equal(clipRetry.retried, undefined);
    assert.equal(clipRetry.job.status, 'failed', 'clip 终态重发保持原语义');
  });
});

test('expired 的 pdf job 同键重提交同样复位重排队（凭据回传超时后点「重试 PDF」）', async () => {
  let now = 1_000;
  await withStore(async ({ store }) => {
    // 真实事故路径（#99 续）：url 型下载撞 403 → awaiting_bytes 等凭据 → 独立短 TTL 到点 expired。
    // 用户按错误提示「重开弹窗重试」点「重试 PDF」，同键重提交必须复位重排，
    // 否则幂等空转、popup 永远停在超时文案
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    await store.claim('attempt-1', 'worker-a', 'pdf');
    await store.awaitBytes('attempt-1', 'worker-a');
    now += 5_001;
    const recovered = await store.recoverExpired();
    assert.deepEqual(recovered.expired, ['attempt-1']);
    assert.equal((await store.get('attempt-1', 'pdf')).status, 'expired');

    const retried = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    assert.equal(retried.retried, true, 'expired pdf 重提交应标记复位重排');
    assert.equal(retried.job.status, 'queued', 'url 型复位回队列由 executor 重下');
    assert.equal(retried.job.error, null);
    assert.equal(retried.job.retryCount, 1);
    assert.equal((await store.list()).length, 1, '复用同一 job 记录，不新增');

    // bytes 型对照：expired 后以新声明重提交 → 回落 awaiting_bytes 等扩展重新喂字节
    await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b', kind: 'pdf', pdfSource: BYTES_SOURCE });
    now += 5_001;
    await store.recoverExpired();
    assert.equal((await store.get('attempt-2', 'pdf')).status, 'expired');
    const bytesRetried = await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b', kind: 'pdf', pdfSource: BYTES_SOURCE });
    assert.equal(bytesRetried.retried, true);
    assert.equal(bytesRetried.job.status, 'awaiting_bytes');
  }, { now: () => now, jobTtlMs: 60_000, awaitingBytesTtlMs: 5_000 });
});

test('存量无 kind 字段的 job 读取时按 clip 迁移', async () => {
  await withStore(async ({ store, filePath }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a' });
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    delete data.jobs[0].kind; // 模拟旧版 job 文件
    await writeFile(filePath, JSON.stringify(data));

    const reloaded = new PersistentJobStore({ filePath });
    const job = await reloaded.get('attempt-1', 'clip');
    assert.equal(job.kind, 'clip', '缺 kind 一律按 clip 读取');
    assert.deepEqual((await reloaded.get('attempt-1')).map((entry) => entry.kind), ['clip']);
    // 迁移后的存量 job 仍可被 claim/complete 正常消费
    await reloaded.claim('attempt-1', 'worker-a');
    await reloaded.beginCreate('attempt-1', 'worker-a');
    await reloaded.recordDocument('attempt-1', 'worker-a', { documentId: 'd1', url: 'https://example.test/d1' });
    assert.equal((await reloaded.complete('attempt-1', 'worker-a')).status, 'succeeded');
  });
});

// ——— 凭据回退（#68）：awaiting_bytes 流转 ———

const BYTES_SOURCE = { type: 'bytes', url: 'https://example.test/x.pdf', name: 'x.pdf', sizeBytes: 5 * 1024 * 1024, totalChunks: 2, sha256: 'b'.repeat(64) };

test('url 型下载撞 401/403：awaitBytes 从 running 转 awaiting_bytes，不 fail', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    await store.claim('attempt-1', 'worker-a', 'pdf');
    const awaiting = await store.awaitBytes('attempt-1', 'worker-a');
    assert.equal(awaiting.status, 'awaiting_bytes');
    assert.equal(awaiting.workerId, null, '释放租约');
    assert.equal(awaiting.error, null, '不是失败');

    // 非活跃 worker 不得转；非 running 状态不得转
    await assert.rejects(() => store.awaitBytes('attempt-1', 'worker-a'), /active worker/);
  });
});

test('markBytesReady / failBytes：只对 awaiting_bytes 生效', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    await assert.rejects(() => store.markBytesReady('attempt-1'), /queued/, 'queued 态不得标记字节就绪');
    await assert.rejects(() => store.failBytes('attempt-1', 'boom'), /queued/);

    await store.claim('attempt-1', 'worker-a', 'pdf');
    await store.awaitBytes('attempt-1', 'worker-a');
    const ready = await store.markBytesReady('attempt-1');
    assert.equal(ready.status, 'queued', '整验通过后重排队等 executor 拾取');
    // 重排队后可正常 claim → complete
    await store.claim('attempt-1', 'worker-b', 'pdf');
    assert.equal((await store.complete('attempt-1', 'worker-b', { document: { fileToken: 'f', url: 'https://u' } }, 'pdf')).status, 'succeeded');

    // hash 不匹配 → failed
    await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b', kind: 'pdf', pdfSource: BYTES_SOURCE });
    const failed = await store.failBytes('attempt-2', 'PDF 字节校验失败（SHA-256 不匹配），已拒绝接收');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /SHA-256/);
    await assert.rejects(() => store.failBytes('attempt-2', 'again'), /failed/, '终态不得重复 failBytes');
  });
});

test('凭据回退升级：url 型 awaiting_bytes 同 url 补交 bytes 声明；声明粘滞，异 sha 拒绝', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    // queued 态不允许直接升级（必须先由 executor 撞 401/403 转 awaiting_bytes）
    const early = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: { ...BYTES_SOURCE, url: PDF_SOURCE.url } });
    assert.equal(early.upgraded, undefined);
    assert.equal(early.job.status, 'queued', '未进 awaiting_bytes 前 bytes 声明不生效');

    await store.claim('attempt-1', 'worker-a', 'pdf');
    await store.awaitBytes('attempt-1', 'worker-a');
    const declaration = { ...BYTES_SOURCE, url: PDF_SOURCE.url };
    const upgraded = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: declaration });
    assert.equal(upgraded.upgraded, true, 'url 型 awaiting_bytes + 同 url bytes 声明 → 升级');
    assert.equal(upgraded.job.status, 'awaiting_bytes', '升级后仍等字节');
    assert.equal(upgraded.job.pdfSource.type, 'bytes');
    assert.equal(upgraded.job.pdfSource.sha256, declaration.sha256);

    // 同声明重复提交幂等；url 型重复提交（弹窗重试路径）也不动声明
    const again = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: declaration });
    assert.equal(again.created, false);
    assert.equal(again.upgraded, undefined);
    const urlAgain = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: PDF_SOURCE });
    assert.equal(urlAgain.job.pdfSource.type, 'bytes', '声明粘滞不被 url 型重提覆盖');

    // 异 sha 声明拒绝（源站内容变了应让任务失败后重来，不中途换声明）
    await assert.rejects(
      () => store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: { ...declaration, sha256: 'c'.repeat(64) } }),
      /another pdf source/,
    );
    // 异 url 声明同样拒绝（绑定校验先于升级分支）
    await assert.rejects(
      () => store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: { ...declaration, url: 'https://example.test/other.pdf' } }),
      /another pdf source/,
    );
  });
});

test('failed 的 bytes 型 pdf job 重提交：复位 awaiting_bytes 并以新声明为准', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: BYTES_SOURCE });
    await store.failBytes('attempt-1', 'hash mismatch');
    const retryDeclaration = { ...BYTES_SOURCE, sha256: 'd'.repeat(64) };
    const retried = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: retryDeclaration });
    assert.equal(retried.retried, true);
    assert.equal(retried.job.status, 'awaiting_bytes', 'bytes 重试回落 awaiting_bytes 等重新喂字节');
    assert.equal(retried.job.pdfSource.sha256, retryDeclaration.sha256, '以新声明为准');
    assert.equal(retried.job.error, null);
  });
});

test('awaiting_bytes 可取消；超龄走 job TTL → expired', async () => {
  let now = 1_000;
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-cancel', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource: BYTES_SOURCE });
    const cancelled = await store.cancel('attempt-cancel', 'pdf');
    assert.equal(cancelled.status, 'cancelled', 'awaiting_bytes 可直接取消');

    await store.submit({ attemptId: 'attempt-stale', sourceUrl: 'https://example.test/b', kind: 'pdf', pdfSource: BYTES_SOURCE });
    now = 1_000 + 10_001;
    const recovered = await store.recoverExpired();
    assert.deepEqual(recovered.expired, ['attempt-stale'], 'awaiting_bytes 超龄 → expired');
    assert.equal((await store.get('attempt-stale', 'pdf')).status, 'expired');
  }, { now: () => now, jobTtlMs: 10_000 });
});

// awaiting_bytes 独立短 TTL：回传链路断在扩展侧（如 CORS 拦截）时 job 不该挂到 job TTL（24h）才死，
// 短 TTL 到点 expired 并写明原因，popup 据此呈现失败而非永远「凭据回传中…」
test('awaiting_bytes 独立 TTL：到点 expired 且带凭据回传超时原因；未显式配置时回落 job TTL', async () => {
  let now = 1_000;
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-feed-stuck', sourceUrl: 'https://example.test/c', kind: 'pdf', pdfSource: BYTES_SOURCE });
    now += 4_999;
    const early = await store.recoverExpired();
    assert.deepEqual(early.expired, [], '未到 awaitingBytesTtlMs 不收');
    now += 2;
    const recovered = await store.recoverExpired();
    assert.deepEqual(recovered.expired, ['attempt-feed-stuck'], 'awaiting_bytes 走独立短 TTL');
    const job = await store.get('attempt-feed-stuck', 'pdf');
    assert.equal(job.status, 'expired');
    assert.match(job.error, /凭据回传超时/, 'expired 需带用户可读的超时原因');
  }, { now: () => now, jobTtlMs: 60_000, awaitingBytesTtlMs: 5_000 });

  // 回归：未配 awaitingBytesTtlMs 时行为与现状一致（回落 jobTtlMs）
  now = 1_000;
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-legacy', sourceUrl: 'https://example.test/d', kind: 'pdf', pdfSource: BYTES_SOURCE });
    now += 5_001;
    const early = await store.recoverExpired();
    assert.deepEqual(early.expired, [], '缺省不按短 TTL 收');
    now += 5_000;
    const recovered = await store.recoverExpired();
    assert.deepEqual(recovered.expired, ['attempt-legacy'], '回落 jobTtlMs');
  }, { now: () => now, jobTtlMs: 10_000 });
});

// ——— AI 摘要（#75）：digest 请求随提交落库；digestText 经 recordDigest 缓存 ———

test('clip job 的 digest 字段随提交落库，存量 job 读取补 null', async () => {
  await withStore(async ({ store, filePath }) => {
    const withDigest = await store.submit({
      attemptId: 'attempt-1',
      sourceUrl: 'https://example.test/article',
      digest: { enabled: true, instruction: '总结成三点' },
    });
    assert.deepEqual(withDigest.job.digest, { enabled: true, instruction: '总结成三点' });
    assert.equal(withDigest.job.digestText, null);

    const plain = await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/other' });
    assert.equal(plain.job.digest, null, '缺省 digest 落 null');
    assert.equal(plain.job.digestText, null);

    // 存量 job 文件没有 digest 字段，读取侧补 null（与 kind 迁移同一约定）
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    for (const job of data.jobs) {
      delete job.digest;
      delete job.digestText;
    }
    await writeFile(filePath, JSON.stringify(data));
    const legacy = await store.get('attempt-1', 'clip');
    assert.equal(legacy.digest, null);
    assert.equal(legacy.digestText, null);
  });
});

// ——— 摘要子文档（#98）：digestDoc 随 subdoc 建档落库，重跑复用同一子文档 ———

test('clip job 新增 digestDoc 字段：提交落 null，存量 job 读取补 null', async () => {
  await withStore(async ({ store, filePath }) => {
    const submitted = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    assert.equal(submitted.job.digestDoc, null, '提交时 digestDoc 落 null');

    const data = JSON.parse(await readFile(filePath, 'utf8'));
    for (const job of data.jobs) delete job.digestDoc;
    await writeFile(filePath, JSON.stringify(data));
    assert.equal((await store.get('attempt-1', 'clip')).digestDoc, null, '存量 job 读取补 null');
  });
});

test('recordDigestDoc 落库摘要子文档（documentId/nodeToken/url）：worker 守卫仿 recordDigest', async () => {
  await withStore(async ({ store, filePath }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article', digest: { enabled: true, instruction: '总结', mode: 'subdoc' } });
    const digestDoc = { documentId: 'doc-digest', nodeToken: 'node-digest', url: 'https://example.feishu.cn/wiki/node-digest' };

    // 非 running / 非活跃 worker 不得写
    await assert.rejects(() => store.recordDigestDoc('attempt-1', 'worker-a', digestDoc), /active worker/);
    await store.claim('attempt-1', 'worker-a');
    await assert.rejects(() => store.recordDigestDoc('attempt-1', 'worker-b', digestDoc), /active worker/);
    // 子文档在建档阶段建成即落库：无 beginCreate 也能写（与 recordDigest 同一约定）
    const recorded = await store.recordDigestDoc('attempt-1', 'worker-a', digestDoc);
    assert.deepEqual(recorded.digestDoc, digestDoc);
    assert.equal(recorded.status, 'running', 'recordDigestDoc 不动状态机');

    // 三个字段缺一拒绝
    await assert.rejects(() => store.recordDigestDoc('attempt-1', 'worker-a', { documentId: 'd', url: 'u' }), /nodeToken/);

    // 持久化往返 + 重启后可读（重跑据此复用同一子文档，同名子文档不堆积）
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(persisted.jobs[0].digestDoc, digestDoc);
    const reloaded = new PersistentJobStore({ filePath });
    assert.deepEqual((await reloaded.get('attempt-1', 'clip')).digestDoc, digestDoc);
  });
});

test('recordDigest 缓存摘要结果：worker 守卫仿 recordDocument（但不要求 createInFlight）', async () => {
  await withStore(async ({ store, filePath }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article', digest: { enabled: true, instruction: '总结' } });

    // 非 running 状态不得写
    await assert.rejects(() => store.recordDigest('attempt-1', 'worker-a', '摘要'), /active worker/);
    await store.claim('attempt-1', 'worker-a');
    // 非活跃 worker 不得写
    await assert.rejects(() => store.recordDigest('attempt-1', 'worker-b', '摘要'), /active worker/);
    // digest 阶段在建档前：无 beginCreate 也能写（与 recordDocument 的差别）
    const recorded = await store.recordDigest('attempt-1', 'worker-a', '摘要内容');
    assert.equal(recorded.digestText, '摘要内容');
    assert.equal(recorded.status, 'running', 'recordDigest 不动状态机');

    // 非字符串拒绝
    await assert.rejects(() => store.recordDigest('attempt-1', 'worker-a', null), /digestText is required/);

    // 持久化往返 + 重启后可读（重跑 #execute 靠它复用缓存不调 AI）
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(persisted.jobs[0].digestText, '摘要内容');
    const reloaded = new PersistentJobStore({ filePath });
    assert.equal((await reloaded.get('attempt-1', 'clip')).digestText, '摘要内容');
  });
});

// ——— clip job 携带 pdfSource（#79）：digest 阶段的 {{@file}} 附件用；重复提交幂等，存量补 null ———

test('clip job 落库带主 PDF source/attachmentId：重复提交幂等保留首值，存量 job 读取补 null', async () => {
  await withStore(async ({ store, filePath }) => {
    const pdfSource = { type: 'url', url: 'https://example.test/paper.pdf', name: 'paper.pdf' };
    const submitted = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article', pdfSource, primaryAttachmentId: 'main-pdf' });
    assert.equal(submitted.created, true);
    assert.deepEqual(submitted.job.pdfSource, pdfSource, 'clip job 落库带 pdfSource');
    assert.equal(submitted.job.primaryAttachmentId, 'main-pdf');

    // 重复提交幂等：同 (attemptId, clip) 键返回既有 job，不带 pdfSource 的重复提交不清空首值
    const again = await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    assert.equal(again.created, false);
    assert.deepEqual(again.job.pdfSource, pdfSource, '幂等命中保留首次落库的 pdfSource');

    const plain = await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/other' });
    assert.equal(plain.job.pdfSource, null, '缺省落 null');

    // 存量 job 文件没有 pdfSource 字段，读取侧补 null（与 digest/kind 迁移同一约定）
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    for (const job of data.jobs) { delete job.pdfSource; delete job.primaryAttachmentId; }
    await writeFile(filePath, JSON.stringify(data));
    assert.equal((await store.get('attempt-1', 'clip')).pdfSource, null);
    assert.equal((await store.get('attempt-1', 'clip')).primaryAttachmentId, null);
  });
});

// ——— requestBytes（#80）：clip digest 撞 401/403 时，pdf job 还排在队列里（提交序 clip 在前、
// executor 串行消费），由 clip 侧把排队中的 url 型 pdf job 直接转 awaiting_bytes 让扩展喂字节 ———

test('requestBytes：排队中的 url 型 pdf job 转 awaiting_bytes；已 awaiting 幂等；非 queued/bytes 型拒绝', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article' });
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article', kind: 'pdf', pdfSource: PDF_SOURCE });

    const requested = await store.requestBytes('attempt-1');
    assert.equal(requested.status, 'awaiting_bytes', 'queued → awaiting_bytes');
    assert.equal(requested.pdfSource.type, 'url', 'url 型声明原样保留（bytes 升级仍走扩展声明）');
    assert.equal((await store.get('attempt-1', 'pdf')).status, 'awaiting_bytes', '落盘可查');

    const again = await store.requestBytes('attempt-1');
    assert.equal(again.status, 'awaiting_bytes', '已 awaiting 幂等空转');

    // bytes 型提交直接落 awaiting_bytes：requestBytes 同样幂等
    const bytes = { type: 'bytes', url: 'https://example.test/b.pdf', name: 'b.pdf', sizeBytes: 4 * 1024 * 1024, totalChunks: 1, sha256: 'a'.repeat(64) };
    await store.submit({ attemptId: 'attempt-2', sourceUrl: 'https://example.test/b.pdf', kind: 'pdf', pdfSource: bytes });
    assert.equal((await store.requestBytes('attempt-2')).status, 'awaiting_bytes', 'bytes 型已在 awaiting，幂等');

    // 终态拒绝：succeeded 的 pdf job 不能再转 awaiting
    await store.submit({ attemptId: 'attempt-3', sourceUrl: 'https://example.test/c.pdf', kind: 'pdf', pdfSource: { type: 'url', url: 'https://example.test/c.pdf' } });
    await store.claim('attempt-3', 'worker-a', 'pdf');
    await store.complete('attempt-3', 'worker-a', { document: { fileToken: 'ft1', url: 'https://example.test/ft1' } }, 'pdf');
    await assert.rejects(() => store.requestBytes('attempt-3'), /Cannot request bytes/);

    await assert.rejects(() => store.requestBytes('attempt-unknown'), /Unknown attemptId/);
  });
});

test('同一剪藏尝试可拥有多个带稳定 attachmentId 的独立 PDF jobs', async () => {
  await withStore(async ({ store }) => {
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article', kind: 'pdf', pdfSource: { type: 'url', url: 'https://example.test/a.pdf' } });
    await store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/article', kind: 'pdf', attachmentId: 'pdf-2', pdfSource: { type: 'url', url: 'https://example.test/b.pdf' } });
    const jobs = await store.get('attempt-1');
    assert.deepEqual(jobs.filter((job) => job.kind === 'pdf').map((job) => job.attachmentId), [null, 'pdf-2']);
    const second = await store.claim('attempt-1', 'worker-b', 'pdf', 'pdf-2');
    assert.equal(second.pdfSource.url, 'https://example.test/b.pdf');
  });
});

test('PDF jobs 重试按稳定 attachmentId 绑定，不受候选顺序变化影响', async () => {
  await withStore(async ({ store }) => {
    const sources = [
      ['supplement', 'https://example.test/supplement.pdf'],
      ['main', 'https://example.test/main.pdf'],
    ];
    for (const [attachmentId, url] of sources) await store.submit({ attemptId: 'attempt-order', sourceUrl: 'https://example.test/article', kind: 'pdf', attachmentId, pdfSource: { type: 'url', url } });
    for (const [attachmentId, url] of sources.toReversed()) await store.submit({ attemptId: 'attempt-order', sourceUrl: 'https://example.test/article', kind: 'pdf', attachmentId, pdfSource: { type: 'url', url } });
    assert.equal((await store.get('attempt-order', 'pdf', 'main')).pdfSource.url, 'https://example.test/main.pdf');
    assert.equal((await store.get('attempt-order', 'pdf', 'supplement')).pdfSource.url, 'https://example.test/supplement.pdf');
  });
});
