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
      assert.equal(args[0], 'docs');
      if (args.includes('--file')) assert.equal(path.isAbsolute(args[args.indexOf('--file') + 1]), false);
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
