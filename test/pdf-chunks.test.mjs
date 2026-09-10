// 分块暂存（#68）：位图/写块/整验/清理的完整生命周期
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDF_CHUNK_BYTES } from '../src/bridge/job-store.mjs';
import { PdfChunkStaging } from '../src/bridge/pdf-chunks.mjs';

const ATTEMPT = 'aaaaaaaa-1111-4111-8111-111111111111';

async function withStaging(run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-staging-'));
  const staging = new PdfChunkStaging({ dir: path.join(directory, 'staging'), ...options });
  try {
    await run({ staging, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const exists = (filePath) => access(filePath).then(() => true, () => false);

test('putChunk 按 offset 落块并维护位图；重发幂等；verify 通过返回文件路径', async () => {
  await withStaging(async ({ staging }) => {
    assert.deepEqual(await staging.bitmap(ATTEMPT), [], '无 sidecar 时位图为空');

    // 两块乱序到达（末块先到）
    const tail = randomBytes(100);
    const first = randomBytes(PDF_CHUNK_BYTES);
    assert.deepEqual(await staging.putChunk(ATTEMPT, 1, tail), [1]);
    assert.deepEqual(await staging.putChunk(ATTEMPT, 0, first), [0, 1]);
    assert.deepEqual(await staging.putChunk(ATTEMPT, 0, first), [0, 1], '重发已收块幂等');

    const sizeBytes = PDF_CHUNK_BYTES + 100;
    const sha256 = createHash('sha256').update(Buffer.concat([first, tail])).digest('hex');
    const filePath = await staging.verify(ATTEMPT, { sizeBytes, sha256 });
    assert.equal(filePath, staging.filePath(ATTEMPT));

    // 并发写不同块：串行化临界区，位图不丢块
    const other = 'bbbbbbbb-1111-4111-8111-111111111111';
    const body = randomBytes(PDF_CHUNK_BYTES);
    await Promise.all([staging.putChunk(other, 1, tail), staging.putChunk(other, 0, body), staging.putChunk(other, 2, tail)]);
    assert.deepEqual(await staging.bitmap(other), [0, 1, 2]);
  });
});

test('verify：大小或 SHA-256 不匹配抛 PDF_HASH_MISMATCH，文件留给调用方清理', async () => {
  await withStaging(async ({ staging }) => {
    const body = randomBytes(64);
    await staging.putChunk(ATTEMPT, 0, body);
    const good = createHash('sha256').update(body).digest('hex');
    await assert.rejects(() => staging.verify(ATTEMPT, { sizeBytes: 63, sha256: good }), { code: 'PDF_HASH_MISMATCH' });
    await assert.rejects(() => staging.verify(ATTEMPT, { sizeBytes: 64, sha256: 'f'.repeat(64) }), { code: 'PDF_HASH_MISMATCH' });
    assert.equal(await exists(staging.filePath(ATTEMPT)), true, 'verify 不自行清理');
    await staging.discard(ATTEMPT);
    assert.equal(await exists(staging.filePath(ATTEMPT)), false);
  });
});

test('discard 删除 .part 与位图 sidecar；sweep 只清超龄孤儿', async () => {
  await withStaging(async ({ staging, directory }) => {
    await staging.putChunk(ATTEMPT, 0, randomBytes(16));
    await staging.discard(ATTEMPT);
    assert.equal(await exists(staging.filePath(ATTEMPT)), false);
    assert.equal(await exists(path.join(directory, 'staging', `${ATTEMPT}.json`)), false);
    assert.deepEqual(await staging.bitmap(ATTEMPT), [], 'discard 后位图清空');

    // 孤儿：新鲜的不动，超龄的整组清掉（含只有 .part 没有 sidecar 的裸文件）
    await staging.putChunk(ATTEMPT, 0, randomBytes(16));
    const orphan = 'cccccccc-1111-4111-8111-111111111111';
    await staging.putChunk(orphan, 0, randomBytes(16));
    const bare = 'dddddddd-1111-4111-8111-111111111111';
    await writeFile(staging.filePath(bare), randomBytes(8));
    // 回填 mtime 模拟超龄（sweep 按文件真实 mtime 判定）
    const old = new Date(Date.now() - 60_000);
    await utimes(staging.filePath(orphan), old, old);
    await utimes(path.join(directory, 'staging', `${orphan}.json`), old, old);
    await utimes(staging.filePath(bare), old, old);

    const removed = await staging.sweep(30_000);
    assert.deepEqual(removed.sort(), [bare, orphan].sort(), '超龄的整组清理（.part + sidecar）');
    assert.equal(await exists(staging.filePath(ATTEMPT)), true, '新鲜的保留');
    assert.equal(await exists(staging.filePath(orphan)), false);
  });
});
