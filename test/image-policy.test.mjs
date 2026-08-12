import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicIp, pinnedLookup, resolvePublicHost, validateImageBytes } from '../src/bridge/image-policy.mjs';

test('SSRF policy rejects loopback, private, link-local, documentation and mapped private IPs', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '192.0.2.1', '::1', 'fc00::1', '2001:db8::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('DNS rebinding defense rejects a hostname if any answer is non-public', async () => {
  await assert.rejects(
    () => resolvePublicHost('example.test', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]),
    /IMAGE_SSRF_REJECTED/,
  );
});

test('pinned DNS lookup supports Node single-address and all-address callback modes', async () => {
  const lookup = pinnedLookup({ address: '8.8.8.8', family: 4 });
  const single = await new Promise((resolve, reject) => lookup('example.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(single, { address: '8.8.8.8', family: 4 });
  const all = await new Promise((resolve, reject) => lookup('example.com', { all: true }, (error, records) => error ? reject(error) : resolve(records)));
  assert.deepEqual(all, [{ address: '8.8.8.8', family: 4 }]);
});

test('image byte policy accepts a small PNG and rejects unsupported or oversized content', () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(180, 20);
  assert.deepEqual(validateImageBytes(png, 'image/png'), { mimeType: 'image/png', extension: 'png', width: 320, height: 180 });
  assert.throws(() => validateImageBytes(png, 'image/svg+xml'), /IMAGE_TYPE_REJECTED/);
  assert.throws(() => validateImageBytes(Buffer.alloc(9 * 1024 * 1024), 'image/png'), /IMAGE_SIZE_REJECTED/);
});
