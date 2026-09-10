// 增量 SHA-256（#68 分块通道第一遍声明用）：与 node:crypto 对拍，含块边界与分片 update
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createIncrementalSha256 } from '../src/extension/sha256.js';

test('与 node:crypto 对拍：各种长度 × 各种分片', () => {
  for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 100_000]) {
    const data = randomBytes(size);
    const reference = createHash('sha256').update(data).digest('hex');
    for (const step of [1, 7, 64, 1000, size || 1]) {
      const hash = createIncrementalSha256();
      for (let offset = 0; offset < size; offset += step) {
        hash.update(data.subarray(offset, Math.min(offset + step, size)));
      }
      assert.equal(hash.hex(), reference, `size=${size} step=${step}`);
    }
  }
});

test('hex 可重复调用且不破坏后续 update', () => {
  const data = randomBytes(200);
  const hash = createIncrementalSha256();
  hash.update(data.subarray(0, 100));
  const first = hash.hex();
  assert.equal(first, createHash('sha256').update(data.subarray(0, 100)).digest('hex'));
  assert.equal(hash.hex(), first, '重复调用结果一致');
  hash.update(data.subarray(100));
  assert.equal(hash.hex(), createHash('sha256').update(data).digest('hex'), '收尾后可继续 update');
});
