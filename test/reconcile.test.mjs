import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClipExecutor } from '../src/bridge/executor.mjs';
import { PersistentJobStore } from '../src/bridge/job-store.mjs';
import { createBridge } from '../src/bridge/server.mjs';

// reconcile() 收尾「建档歧义」（create 超时但服务端可能已建出，协议见 docs/job-protocol.md）：
// 按目的地 wiki 反查同名 docx 节点，正文带「剪藏尝试：<attemptId>」标记才采纳续跑；
// 查无此档才重排 create_document。无标记的同名文档无法确证归属，一律按未建处理。

async function seedAmbiguous(store, { attemptId, title = '测试页', destination, cancel = false } = {}) {
  await store.submit({
    attemptId,
    sourceUrl: 'https://example.com/article',
    snapshot: { title, sourceUrl: 'https://example.com/article', capturedAt: '2026-09-01T00:00:00.000Z', markdown: '# 正文' },
    destination: destination ?? { kind: 'node', nodeToken: 'parent-1', spaceId: 'space-1' },
    includeImages: false,
  });
  await store.claim(attemptId, 'worker-1');
  await store.beginCreate(attemptId, 'worker-1');
  await store.markCreateAmbiguous(attemptId, 'worker-1');
  if (cancel) await store.cancel(attemptId);
}

// node-list 不返回 obj_create_time（真实 API 行为），创建时间由逐候选的 node-get 提供；
// nodeDetails 缺省返回当前时间（落在时间窗内）
function fakeReconcileLark({ nodes = [], contents = {}, nodeDetails = {}, failOn } = {}) {
  const calls = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      if (failOn?.(args)) throw new Error('lark boom');
      if (args[0] === 'wiki' && args[1] === '+node-list') return { ok: true, data: { nodes, has_more: false } };
      if (args[0] === 'wiki' && args[1] === '+node-get') {
        const token = args[args.indexOf('--node-token') + 1];
        return { ok: true, data: nodeDetails[token] ?? { obj_create_time: String(Math.floor(Date.now() / 1000)) } };
      }
      if (args[0] === 'docs' && args[1] === '+fetch') {
        const doc = args[args.indexOf('--doc') + 1];
        return { ok: true, data: { document: { content: contents[doc] ?? '' } } };
      }
      throw new Error(`unexpected lark call: ${args.join(' ')}`);
    },
  };
}

async function withHarness(setup, fn) {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-reconcile-'));
  try {
    const store = new PersistentJobStore({ filePath: path.join(directory, 'jobs.json') });
    await setup(store);
    const lark = fakeReconcileLark(await fn.setup?.() || {});
    const executor = new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} } });
    await executor.reconcile();
    await fn.assert({ store, lark });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// node-list 的真实响应没有 obj_create_time（创建时间走 node-get 补齐），夹据保持同形
const docNode = (overrides = {}) => ({
  node_token: 'node-found',
  obj_token: 'docx-found',
  obj_type: 'docx',
  title: '测试页',
  ...overrides,
});

test('正文带本尝试标记的同名文档被采纳：记录 document 并重排 write_body', async () => {
  await withHarness(
    (store) => seedAmbiguous(store, { attemptId: 'attempt-hit' }),
    {
      setup: () => ({ nodes: [docNode()], contents: { 'docx-found': '<title>测试页</title><blockquote>剪藏尝试：attempt-hit</blockquote>' } }),
      assert: async ({ store }) => {
        const job = await store.get('attempt-hit');
        assert.equal(job.status, 'queued');
        assert.equal(job.step, 'write_body');
        assert.deepEqual(job.document, { documentId: 'docx-found', url: 'https://my.feishu.cn/wiki/node-found' });
        assert.equal(job.ambiguousSince, null);
      },
    },
  );
});

test('目标下无同名节点：确认未建，重排 create_document', async () => {
  await withHarness(
    (store) => seedAmbiguous(store, { attemptId: 'attempt-absent' }),
    {
      setup: () => ({ nodes: [docNode({ title: '别的文档', obj_token: 'docx-other' })] }),
      assert: async ({ store, lark }) => {
        const job = await store.get('attempt-absent');
        assert.equal(job.status, 'queued');
        assert.equal(job.step, 'create_document');
        assert.equal(job.document, null);
        assert.ok(!lark.calls.some((args) => args[1] === '+fetch'), '无同名候选不该拉正文');
        assert.ok(!lark.calls.some((args) => args[1] === '+node-get'), '无同名候选不该补查详情');
      },
    },
  );
});

test('同名文档但标记属于别的尝试：无法确证归属，按未建重排 create', async () => {
  await withHarness(
    (store) => seedAmbiguous(store, { attemptId: 'attempt-mine' }),
    {
      setup: () => ({ nodes: [docNode()], contents: { 'docx-found': '<blockquote>剪藏尝试：attempt-other</blockquote>' } }),
      assert: async ({ store }) => {
        const job = await store.get('attempt-mine');
        assert.equal(job.status, 'queued');
        assert.equal(job.step, 'create_document');
        assert.equal(job.document, null);
      },
    },
  );
});

test('同名文档正文没有标记（空文档）：按未建重排 create，不盲目采纳', async () => {
  await withHarness(
    (store) => seedAmbiguous(store, { attemptId: 'attempt-empty' }),
    {
      setup: () => ({ nodes: [docNode()], contents: { 'docx-found': '' } }),
      assert: async ({ store }) => {
        const job = await store.get('attempt-empty');
        assert.equal(job.status, 'queued');
        assert.equal(job.step, 'create_document');
        assert.equal(job.document, null);
      },
    },
  );
});

test('取消等待查证的任务：查到文档后落 cancelled_with_document 并保留 URL', async () => {
  await withHarness(
    (store) => seedAmbiguous(store, { attemptId: 'attempt-cancel', cancel: true }),
    {
      setup: () => ({ nodes: [docNode()], contents: { 'docx-found': '剪藏尝试：attempt-cancel' } }),
      assert: async ({ store }) => {
        const job = await store.get('attempt-cancel');
        assert.equal(job.status, 'cancelled_with_document');
        assert.equal(job.step, 'done');
        assert.equal(job.document.url, 'https://my.feishu.cn/wiki/node-found');
      },
    },
  );
});

test('查证过程 lark 报错：任务保持 reconciling 等下轮 sweep，不抛出', async () => {
  await withHarness(
    (store) => seedAmbiguous(store, { attemptId: 'attempt-error' }),
    {
      setup: () => ({ failOn: () => true }),
      assert: async ({ store }) => {
        const job = await store.get('attempt-error');
        assert.equal(job.status, 'reconciling');
      },
    },
  );
});

test('space 目标在空间根层反查（不带 parent-node-token）', async () => {
  await withHarness(
    (store) => seedAmbiguous(store, { attemptId: 'attempt-space', destination: { kind: 'space', spaceId: 'space-9' } }),
    {
      setup: () => ({ nodes: [docNode()], contents: { 'docx-found': '剪藏尝试：attempt-space' } }),
      assert: async ({ store, lark }) => {
        const job = await store.get('attempt-space');
        assert.equal(job.step, 'write_body');
        const [listCall] = lark.calls.filter((args) => args[1] === '+node-list');
        assert.ok(listCall.includes('--space-id') && listCall.includes('space-9'));
        assert.ok(!listCall.includes('--parent-node-token'), '空间根目标不带父节点');
      },
    },
  );
});

test('非 docx 同名节点（如知识库快捷方式）不作为候选', async () => {
  await withHarness(
    (store) => seedAmbiguous(store, { attemptId: 'attempt-shortcut' }),
    {
      setup: () => ({ nodes: [docNode({ obj_type: 'shortcut', obj_token: 'docx-short' })] }),
      assert: async ({ store, lark }) => {
        const job = await store.get('attempt-shortcut');
        assert.equal(job.step, 'create_document', 'shortcut 不算命中，重排 create');
        assert.ok(!lark.calls.some((args) => args[1] === '+fetch'));
      },
    },
  );
});

// 周期 sweep 集成：bridge 不重启，靠 interval 把 reconciling 任务查证并跑完（#51）
test('bridge 周期 sweep：reconciling 任务无需重启即被查证、续跑至终态', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-sweep-'));
  const pairingFile = path.join(directory, 'pairing.json');
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: null }));
  try {
    const attemptId = 'attempt-sweep';
    const lark = fakeReconcileLark({
      nodes: [docNode()],
      contents: { 'docx-found': '<blockquote>剪藏尝试：attempt-sweep</blockquote>' },
    });
    const { store } = await createBridge({
      config: {
        version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake',
        pairingFile, jobFile: path.join(directory, 'jobs.json'), sweepIntervalMs: 25,
      },
      lark,
      logger: { error() {}, log() {}, warn() {} },
    });
    // 启动 sweep 之后才出现歧义任务，只能靠周期 sweep 捞起
    await seedAmbiguous(store, { attemptId });
    let job;
    for (let count = 0; count < 80; count += 1) {
      job = await store.get(attemptId);
      if (job.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(job.status, 'succeeded', '查证命中后重排 write_body 并被 sweep 的 kick 跑完');
    assert.equal(job.document.url, 'https://my.feishu.cn/wiki/node-found');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('同名节点但创建时间在任务窗口之外：不拉正文，按未建处理', async () => {
  await withHarness(
    (store) => seedAmbiguous(store, { attemptId: 'attempt-stale' }),
    {
      setup: () => ({
        nodes: [docNode()],
        nodeDetails: { 'node-found': { obj_create_time: String(Math.floor(Date.now() / 1000) - 86400) } },
      }),
      assert: async ({ store, lark }) => {
        const job = await store.get('attempt-stale');
        assert.equal(job.step, 'create_document');
        assert.ok(!lark.calls.some((args) => args[1] === '+fetch'), '窗口外的候选不该拉正文');
      },
    },
  );
});

test('确认未建后重排 create：kick 跑完建档成功，且不重复建文档', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-reconcile-'));
  try {
    const store = new PersistentJobStore({ filePath: path.join(directory, 'jobs.json') });
    await seedAmbiguous(store, { attemptId: 'attempt-recreate' });
    const lark = fakeReconcileLark({ nodes: [] });
    // 重排后的 create 走正常建档路径
    const baseRun = lark.run;
    lark.run = async (args) => {
      if (args[0] === 'docs' && args[1] === '+create') {
        lark.calls.push(args); // 提前返回也要留痕，供「只建一次」断言
        return { ok: true, data: { document: { document_id: 'docx-new', url: 'https://example.feishu.cn/wiki/docx-new' } } };
      }
      return baseRun(args);
    };
    const executor = new ClipExecutor({ store, lark, logger: { warn() {}, error() {}, log() {} } });
    await executor.reconcile();
    executor.kick();
    for (let count = 0; count < 80; count += 1) {
      const job = await store.get('attempt-recreate');
      if (['succeeded', 'succeeded_with_warnings', 'failed'].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const job = await store.get('attempt-recreate');
    assert.equal(job.status, 'succeeded');
    assert.equal(job.document.documentId, 'docx-new');
    assert.equal(lark.calls.filter((args) => args[1] === '+create').length, 1, '只建一次文档');
    assert.ok(!lark.calls.some((args) => args[1] === '+node-delete'), '成功路径不触发清理');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bridge 周期 sweep：查证持续失败的任务超 jobTtlMs 后无需重启即转 needs_attention', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-sweep-ttl-'));
  const pairingFile = path.join(directory, 'pairing.json');
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: null }));
  try {
    const attemptId = 'attempt-ttl';
    // lark 全部失败：reconcile 查不出结果，任务只能等 TTL 兜底
    const lark = fakeReconcileLark({ failOn: () => true });
    const { store } = await createBridge({
      config: {
        version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake',
        pairingFile, jobFile: path.join(directory, 'jobs.json'), sweepIntervalMs: 25, jobTtlMs: 50,
      },
      lark,
      logger: { error() {}, log() {}, warn() {} },
    });
    await seedAmbiguous(store, { attemptId });
    let job;
    for (let count = 0; count < 80; count += 1) {
      job = await store.get(attemptId);
      if (job.status === 'needs_attention') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(job.status, 'needs_attention', '周期 sweep 的 recoverExpired 应把过期 reconciling 转 needs_attention');
    assert.equal(job.error, 'Document creation could not be reconciled before expiry');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
