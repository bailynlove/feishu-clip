// 一次性真实账号验证脚本：用真实 lark-cli 启动 Bridge，完成配对后调用
// /v1/targets/spaces 与 /v1/targets/nodes 两个新端点。验证后删除临时目录。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/bridge/server.mjs';

const origin = `chrome-extension://${'b'.repeat(32)}`;
const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-real-'));
const pairingFile = path.join(directory, 'pairing.json');
const code = 'real-acceptance-code';
await writeFile(pairingFile, JSON.stringify({ active: null, pending: { digest: createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + 60_000, attempts: 0 } }));

const { server } = await createBridge({
  config: { version: 'acceptance', host: '127.0.0.1', port: 0, larkCliPath: 'lark-cli', pairingFile, jobFile: path.join(directory, 'jobs.json') },
  logger: { error: console.error, log() {} },
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const paired = await (await fetch(`${base}/v1/pair`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
  assert.equal(paired.ok, true, 'pairing failed');
  const call = (url) => fetch(`${base}${url}`, { headers: { Origin: origin, Authorization: `Bearer ${paired.credential}` } }).then((res) => res.json());

  const status = await call('/v1/status');
  console.log('status:', JSON.stringify(status.larkAuth));
  assert.equal(status.larkAuth.ready, true, 'lark user not ready');

  const spaces = await call('/v1/targets/spaces?limit=3');
  assert.equal(spaces.ok, true);
  console.log(`spaces page 1: ${spaces.spaces.length} space(s), hasMore=${spaces.hasMore}`);
  for (const space of spaces.spaces) console.log(`  - ${space.name} (${space.spaceId}, ${space.spaceType})`);
  assert.ok(spaces.spaces.length > 0, 'no spaces visible');

  if (spaces.hasMore) {
    const page2 = await call(`/v1/targets/spaces?cursor=${encodeURIComponent(spaces.nextPageToken)}&limit=3`);
    assert.equal(page2.ok, true);
    console.log(`spaces page 2: ${page2.spaces.length} space(s), hasMore=${page2.hasMore}`);
    assert.ok(page2.spaces.every((space) => !spaces.spaces.some((first) => first.spaceId === space.spaceId)), 'page 2 overlaps page 1');
  }

  const space = spaces.spaces[0];
  const root = await call(`/v1/targets/nodes?spaceId=${space.spaceId}&limit=5`);
  assert.equal(root.ok, true);
  console.log(`root nodes of ${space.name}: ${root.nodes.length}, hasMore=${root.hasMore}`);
  for (const node of root.nodes) console.log(`  - ${node.title} (${node.objType}, hasChildren=${node.hasChildren})`);
  assert.ok(root.nodes.length > 0, 'no root nodes');
  assert.ok(root.nodes.every((node) => node.nodeToken && node.title), 'node summary incomplete');

  const validated = await call('/v1/destinations/validate');
  assert.equal(validated.ok, false, 'validate without nodeToken must fail');

  console.log('REAL ACCEPTANCE PASSED');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
