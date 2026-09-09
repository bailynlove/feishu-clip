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

test('pdf job 提交校验：只接受 url 型、http(s) 无凭据', async () => {
  await withStore(async ({ store }) => {
    const submit = (pdfSource) => store.submit({ attemptId: 'attempt-1', sourceUrl: 'https://example.test/a', kind: 'pdf', pdfSource });
    await assert.rejects(() => submit(null), /pdfSource.type/);
    await assert.rejects(() => submit({ type: 'bytes', url: 'https://example.test/x.pdf' }), /pdfSource.type/);
    await assert.rejects(() => submit({ type: 'url', url: 'not-a-url' }), /valid URL/);
    await assert.rejects(() => submit({ type: 'url', url: 'ftp://example.test/x.pdf' }), /credential-free/);
    await assert.rejects(() => submit({ type: 'url', url: 'https://user:pass@example.test/x.pdf' }), /credential-free/);
    const ok = await submit({ type: 'url', url: 'https://example.test/x.pdf', name: 'x'.repeat(300), sizeBytes: 42 });
    assert.equal(ok.job.pdfSource.name.length, 250, 'name 截断到 250 字符');
    assert.equal(ok.job.pdfSource.sizeBytes, 42);
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
