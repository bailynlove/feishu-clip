import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBridge } from '../src/bridge/server.mjs';
import { LarkClient } from '../src/bridge/lark.mjs';

const origin = `chrome-extension://${'b'.repeat(32)}`;

async function startBridge(fakeLark) {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-targets-'));
  const pairingFile = path.join(directory, 'pairing.json');
  const code = 'correct-pairing-code';
  await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile, jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark,
    logger: { error() {}, log() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const paired = await (await fetch(`${base}/v1/pair`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
  assert.equal(paired.ok, true);
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, Authorization: `Bearer ${paired.credential}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  return {
    call,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function fakeLark(overrides = {}) {
  return {
    authStatus: async () => ({ ready: true, identity: 'tester' }),
    validateDestination: async ({ nodeToken }) => ({ nodeToken, spaceId: 'space-1', title: '验收目录', objType: 'docx' }),
    listSpaces: async () => ({ spaces: [{ spaceId: 'space-1', name: 'Project', spaceType: 'team' }], hasMore: false, nextPageToken: null }),
    listNodes: async () => ({ nodes: [{ nodeToken: 'wikcn-root-1', spaceId: 'space-1', title: '首页', objType: 'docx', hasChildren: true }], hasMore: false, nextPageToken: null }),
    run: async () => ({ ok: true, data: {} }),
    ...overrides,
  };
}

test('targets routes require pairing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-targets-'));
  await writeFile(path.join(directory, 'pairing.json'), JSON.stringify({ active: null, pending: null }));
  const { server } = await createBridge({
    config: { version: 'test', host: '127.0.0.1', port: 0, larkCliPath: '/fake', pairingFile: path.join(directory, 'pairing.json'), jobFile: path.join(directory, 'jobs.json') },
    lark: fakeLark(),
    logger: { error() {}, log() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unpaired = await fetch(`${base}/v1/targets/spaces`, { headers: { Origin: origin } });
    assert.equal(unpaired.status, 401);
    assert.equal((await unpaired.json()).code, 'PAIRING_REQUIRED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('spaces route lists spaces with pagination and exposes only whitelisted fields', async () => {
  const seen = [];
  const lark = fakeLark({
    listSpaces: async ({ pageToken, pageSize }) => {
      seen.push({ pageToken, pageSize });
      if (!pageToken) return { spaces: [{ spaceId: 'space-1', name: 'Project', spaceType: 'team' }], hasMore: true, nextPageToken: 'cursor-2' };
      return { spaces: [{ spaceId: 'space-2', name: 'Area', spaceType: 'team' }], hasMore: false, nextPageToken: null };
    },
  });
  const bridge = await startBridge(lark);
  try {
    const first = await (await bridge.call('/v1/targets/spaces?limit=20')).json();
    assert.equal(first.ok, true);
    assert.deepEqual(first.spaces, [{ spaceId: 'space-1', name: 'Project', spaceType: 'team' }]);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextPageToken, 'cursor-2');
    const second = await (await bridge.call(`/v1/targets/spaces?cursor=${encodeURIComponent('cursor-2')}&limit=20`)).json();
    assert.deepEqual(second.spaces, [{ spaceId: 'space-2', name: 'Area', spaceType: 'team' }]);
    assert.equal(second.hasMore, false);
    assert.deepEqual(seen, [{ pageToken: undefined, pageSize: 20 }, { pageToken: 'cursor-2', pageSize: 20 }]);
  } finally {
    await bridge.close();
  }
});

test('nodes route validates query parameters and never forwards arbitrary input', async () => {
  const seen = [];
  const lark = fakeLark({
    listNodes: async (params) => {
      seen.push(params);
      return { nodes: [{ nodeToken: 'wikcn-child-1', spaceId: params.spaceId, title: '子文档', objType: 'docx', hasChildren: false }], hasMore: true, nextPageToken: 'node-cursor' };
    },
  });
  const bridge = await startBridge(lark);
  try {
    assert.equal((await bridge.call('/v1/targets/nodes')).status, 400, 'spaceId is required');
    assert.equal((await bridge.call('/v1/targets/nodes?spaceId=bad token!')).status, 400);
    assert.equal((await bridge.call('/v1/targets/nodes?spaceId=space-1&parentNodeToken=../../etc')).status, 400);
    assert.equal((await bridge.call('/v1/targets/nodes?spaceId=space-1&limit=0')).status, 400);
    assert.equal((await bridge.call('/v1/targets/nodes?spaceId=space-1&limit=51')).status, 400);
    assert.equal((await bridge.call('/v1/targets/nodes?spaceId=space-1&limit=2.5')).status, 400);
    assert.equal((await bridge.call(`/v1/targets/nodes?spaceId=space-1&cursor=${'x'.repeat(513)}`)).status, 400);
    assert.equal((await bridge.call('/v1/targets/nodes?spaceId=space-1&--page-all=true')).status, 400, 'unknown query keys are rejected');
    assert.equal((await bridge.call('/v1/targets/nodes/extra?spaceId=space-1')).status, 404);

    const root = await (await bridge.call('/v1/targets/nodes?spaceId=space-1&limit=20')).json();
    assert.equal(root.ok, true);
    assert.deepEqual(root.nodes, [{ nodeToken: 'wikcn-child-1', spaceId: 'space-1', title: '子文档', objType: 'docx', hasChildren: false }]);
    const child = await (await bridge.call(`/v1/targets/nodes?spaceId=space-1&parentNodeToken=wikcn-root-1&cursor=${encodeURIComponent('node-cursor')}`)).json();
    assert.equal(child.ok, true);
    assert.deepEqual(seen, [
      { spaceId: 'space-1', parentNodeToken: undefined, pageToken: undefined, pageSize: 20 },
      { spaceId: 'space-1', parentNodeToken: 'wikcn-root-1', pageToken: 'node-cursor', pageSize: 50 },
    ]);
  } finally {
    await bridge.close();
  }
});

test('targets routes map lark failures to actionable codes', async () => {
  const lark = fakeLark({
    listSpaces: async () => { throw Object.assign(new Error('user not logged in, run auth login'), { code: 'AUTH_FAILED' }); },
    listNodes: async () => { throw Object.assign(new Error('permission denied for wiki space'), { code: '99991679' }); },
  });
  const bridge = await startBridge(lark);
  try {
    const spaces = await bridge.call('/v1/targets/spaces');
    assert.equal(spaces.status, 503);
    assert.equal((await spaces.json()).code, 'LARK_AUTH_REQUIRED');
    const nodes = await bridge.call('/v1/targets/nodes?spaceId=space-1');
    assert.equal(nodes.status, 403);
    assert.equal((await nodes.json()).code, 'LARK_PERMISSION_DENIED');
  } finally {
    await bridge.close();
  }
});

test('LarkClient builds bounded read-only argv and maps envelope fields', async () => {
  const calls = [];
  const client = new LarkClient({ cliPath: '/fake' });
  client.run = async (args) => {
    calls.push(args);
    if (args[1] === '+space-list') {
      return { ok: true, data: { has_more: true, page_token: 'next', spaces: [{ space_id: 's1', name: 'Project', space_type: 'team', extra: 'dropped' }] } };
    }
    return { ok: true, data: { has_more: false, nodes: [{ node_token: 'n1', space_id: 's1', title: '首页', obj_type: 'docx', has_child: true, obj_token: 'dropped' }] } };
  };

  const spaces = await client.listSpaces({ pageSize: 20 });
  assert.deepEqual(calls[0], ['wiki', '+space-list', '--as', 'user', '--page-size', '20', '--format', 'json']);
  assert.deepEqual(spaces, { spaces: [{ spaceId: 's1', name: 'Project', spaceType: 'team' }], hasMore: true, nextPageToken: 'next' });

  const nodes = await client.listNodes({ spaceId: 's1', parentNodeToken: 'n0', pageToken: 'cursor', pageSize: 10 });
  assert.deepEqual(calls[1], ['wiki', '+node-list', '--as', 'user', '--space-id', 's1', '--page-size', '10', '--format', 'json', '--parent-node-token', 'n0', '--page-token', 'cursor']);
  assert.deepEqual(nodes, { nodes: [{ nodeToken: 'n1', spaceId: 's1', title: '首页', objType: 'docx', hasChildren: true }], hasMore: false, nextPageToken: null });

  const rootNodes = await client.listNodes({ spaceId: 's1' });
  assert.equal(rootNodes.nodes.length, 1);
  assert.ok(!calls[2].includes('--parent-node-token'), 'root listing omits parent token');
  assert.ok(!calls[2].includes('--page-token'), 'no page token without cursor');
});

test('LarkClient validates space destinations and keeps node destinations working', async () => {
  const calls = [];
  const client = new LarkClient({ cliPath: '/fake' });
  client.run = async (args) => {
    calls.push(args);
    if (args[1] === 'spaces') return { ok: true, data: { space: { space_id: 's1', name: 'Project', space_type: 'team' } } };
    return { ok: true, data: { node: { node_token: 'n1', space_id: 's1', title: '目录', obj_type: 'docx' } } };
  };

  const space = await client.validateDestination({ spaceId: 's1' });
  assert.deepEqual(calls[0], ['wiki', 'spaces', 'get', '--as', 'user', '--space-id', 's1', '--format', 'json']);
  assert.deepEqual(space, { kind: 'space', spaceId: 's1', title: 'Project', objType: null });

  const node = await client.validateDestination({ nodeToken: 'n1' });
  assert.equal(node.kind, 'node');
  assert.equal(node.nodeToken, 'n1');
});

test('space destination validates and creates the document at the space root', async () => {
  const calls = [];
  const lark = fakeLark({
    validateDestination: async ({ spaceId }) => ({ kind: 'space', spaceId, title: 'Project', objType: null }),
    run: async (args) => {
      calls.push(args);
      if (args[1] === '+node-create') return { ok: true, data: { node: { node_token: 'wn-new', obj_token: 'docx-new', url: 'https://example.feishu.cn/wiki/wn-new' } } };
      return { ok: true, data: {} };
    },
  });
  const bridge = await startBridge(lark);
  try {
    const validated = await (await bridge.call('/v1/destinations/validate', { method: 'POST', body: JSON.stringify({ kind: 'space', spaceId: 's1' }) })).json();
    assert.equal(validated.ok, true);
    assert.equal(validated.destination.kind, 'space');
    assert.equal((await bridge.call('/v1/destinations/validate', { method: 'POST', body: JSON.stringify({}) })).status, 400);
    assert.equal((await bridge.call('/v1/jobs', { method: 'POST', body: JSON.stringify({ attemptId: '33333333-3333-4333-8333-333333333333', destination: {}, snapshot: { title: 't', sourceUrl: 'https://example.com', markdown: 'x' } }) })).status, 400);

    const attemptId = '22222222-2222-4222-8222-222222222222';
    const submitted = await bridge.call('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ attemptId, destination: { kind: 'space', spaceId: 's1' }, snapshot: { title: '空间根剪藏', sourceUrl: 'https://example.com/article', capturedAt: new Date().toISOString(), markdown: '# 正文' } }),
    });
    assert.equal(submitted.status, 202);
    let job;
    for (let count = 0; count < 30; count += 1) {
      job = (await (await bridge.call(`/v1/jobs/${attemptId}`)).json()).job;
      if (['succeeded', 'succeeded_with_warnings', 'failed', 'needs_attention'].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, 'succeeded', `job ended in ${job.status}: ${job.error || ''}`);
    assert.equal(job.document.url, 'https://example.feishu.cn/wiki/wn-new');
    assert.deepEqual(calls[0], ['wiki', '+node-create', '--as', 'user', '--space-id', 's1', '--obj-type', 'docx', '--title', '空间根剪藏', '--format', 'json']);
    assert.deepEqual(calls[1].slice(0, 8), ['docs', '+update', '--as', 'user', '--doc', 'docx-new', '--command', 'append']);
    assert.ok(calls[1].includes('--content'), 'second step writes the markdown body');
  } finally {
    await bridge.close();
  }
});
