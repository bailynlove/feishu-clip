// 一次性真实账号验收脚本（#22）：经生产 Bridge 验证空间目标，并在空间根层创建一篇真实剪藏文档。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/bridge/server.mjs';

const origin = `chrome-extension://${'b'.repeat(32)}`;
const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-real-space-'));
const pairingFile = path.join(directory, 'pairing.json');
const code = 'real-space-acceptance-code';
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
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Origin: origin, Authorization: `Bearer ${paired.credential}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } }).then((res) => res.json());

  const spaces = await call('/v1/targets/spaces?limit=1');
  const space = spaces.spaces[0];
  console.log(`target space: ${space.name} (${space.spaceId})`);

  const validated = await call('/v1/destinations/validate', { method: 'POST', body: JSON.stringify({ kind: 'space', spaceId: space.spaceId }) });
  assert.equal(validated.ok, true);
  assert.equal(validated.destination.kind, 'space');
  assert.equal(validated.destination.title, space.name);
  console.log('space destination validated:', JSON.stringify(validated.destination));

  const attemptId = crypto.randomUUID();
  const submitted = await call('/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      attemptId,
      destination: validated.destination,
      includeImages: false,
      snapshot: {
        title: '网页剪藏验收（空间根目标）',
        sourceUrl: 'https://example.com/space-root-acceptance',
        capturedAt: new Date().toISOString(),
        markdown: '# 空间根目标验收\n\n这是一篇由验收脚本创建的文档，应出现在知识库根层。',
      },
    }),
  });
  assert.equal(submitted.ok, true);

  let job;
  for (let count = 0; count < 60; count += 1) {
    job = (await call(`/v1/jobs/${attemptId}`)).job;
    if (['succeeded', 'succeeded_with_warnings', 'failed', 'needs_attention', 'expired'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(job.status, 'succeeded', `job ended in ${job.status}: ${job.error || ''}`);
  console.log('created document:', job.document.url);

  const root = await call(`/v1/targets/nodes?spaceId=${space.spaceId}&limit=50`);
  const found = root.nodes.find((node) => node.title === '网页剪藏验收（空间根目标）');
  assert.ok(found, 'created document not found at space root');
  console.log('confirmed at space root:', found.nodeToken);
  console.log('REAL SPACE-TARGET ACCEPTANCE PASSED');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
