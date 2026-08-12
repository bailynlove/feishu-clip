import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPairingCode, PairingStore } from '../src/bridge/pairing.mjs';

test('pairing atomically binds one extension origin and replaces the old credential only on success', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feishu-clip-pair-'));
  const file = path.join(directory, 'pairing.json');
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  try {
    const { code, pending } = createPairingCode(1_000);
    await writeFile(file, JSON.stringify({ active: { origin, credential: 'old' }, pending }), { mode: 0o600 });
    const store = new PairingStore(file, { now: () => 2_000 });
    assert.equal((await store.pair(origin, 'wrong')).code, 'PAIRING_CODE_INVALID');
    assert.equal((await store.authorize(origin, 'old')).ok, true);
    const result = await store.pair(origin, code);
    assert.equal(result.ok, true);
    assert.equal((await store.authorize(origin, 'old')).code, 'PAIRING_REPLACED');
    assert.equal((await store.authorize(origin, result.credential)).ok, true);
    assert.equal(JSON.parse(await readFile(file)).pending, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pairing rejects non-extension origins', async () => {
  const store = new PairingStore('/unused');
  assert.deepEqual(await store.pair('https://example.com', 'code'), { ok: false, code: 'ORIGIN_MISMATCH' });
});
