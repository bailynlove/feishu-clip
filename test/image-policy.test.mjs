import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicIp, parseImageDimensions, pinnedLookup, resolvePublicHost, validateImageBytes } from '../src/bridge/image-policy.mjs';

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

test('magic bytes win over a lying extension/Content-Type (.png URL serving JPEG)', () => {
  // 真实案例：cs.cmu.edu/~hovy/bio-image-hovy.png 实为 6000x4000 JPEG，
  // 按 PNG 偏移读尺寸会读出垃圾值触发 DIMENSIONS 误杀
  const jpeg = Buffer.alloc(16);
  jpeg.writeUInt16BE(0xffd8, 0); // SOI
  jpeg.writeUInt16BE(0xffc0, 2); // SOF0
  jpeg.writeUInt16BE(0x0011, 4); // 段长
  jpeg.writeUInt8(0x08, 6); // 精度
  jpeg.writeUInt16BE(4000, 7); // 高
  jpeg.writeUInt16BE(6000, 9); // 宽
  assert.deepEqual(validateImageBytes(jpeg, 'image/png'), { mimeType: 'image/jpeg', extension: 'jpg', width: 6000, height: 4000 });
});

// parseImageDimensions：建图片块时需要原始宽高（飞书 replace_image 不重算尺寸），
// 按魔数识别后手工解析四种格式的头部，解析不了返回 null 由调用方留空块
test('parseImageDimensions reads PNG IHDR and JPEG SOF0/1/2 markers', () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(4572, 16);
  png.writeUInt32BE(2047, 20);
  assert.deepEqual(parseImageDimensions(png), { width: 4572, height: 2047 });

  for (const sof of [0xc0, 0xc1, 0xc2]) {
    const jpeg = Buffer.alloc(16);
    jpeg.writeUInt16BE(0xffd8, 0); // SOI
    jpeg.writeUInt16BE(0xff00 | sof, 2); // SOF0/1/2
    jpeg.writeUInt16BE(0x0011, 4);
    jpeg.writeUInt8(0x08, 6);
    jpeg.writeUInt16BE(180, 7); // 高
    jpeg.writeUInt16BE(320, 9); // 宽
    assert.deepEqual(parseImageDimensions(jpeg), { width: 320, height: 180 }, `SOF marker 0x${sof.toString(16)}`);
  }
});

test('parseImageDimensions reads GIF logical screen descriptor', () => {
  const gif = Buffer.alloc(10);
  gif.write('GIF89a', 0, 'latin1');
  gif.writeUInt16LE(480, 6);
  gif.writeUInt16LE(270, 8);
  assert.deepEqual(parseImageDimensions(gif), { width: 480, height: 270 });
});

test('parseImageDimensions reads WebP VP8X, lossless VP8L and lossy VP8 headers', () => {
  const riff = (chunk) => {
    const buffer = Buffer.alloc(30);
    buffer.write('RIFF', 0, 'latin1');
    buffer.write('WEBP', 8, 'latin1');
    buffer.write(chunk, 12, 'latin1');
    return buffer;
  };
  const vp8x = riff('VP8X');
  vp8x.writeUIntLE(319, 24, 3); // 宽存的是减 1
  vp8x.writeUIntLE(179, 27, 3);
  assert.deepEqual(parseImageDimensions(vp8x), { width: 320, height: 180 });

  const vp8l = riff('VP8L');
  vp8l.writeUInt8(0x2f, 20); // VP8L 签名
  vp8l.writeUInt32LE(((179 << 14) | 319) >>> 0, 21); // 宽低 14 位、高次 14 位，各存减 1
  assert.deepEqual(parseImageDimensions(vp8l), { width: 320, height: 180 });

  const vp8 = riff('VP8 ');
  vp8.writeUInt8(0x9d, 23); // 起始码 9d 01 2a
  vp8.writeUInt8(0x01, 24);
  vp8.writeUInt8(0x2a, 25);
  vp8.writeUInt16LE(320, 26);
  vp8.writeUInt16LE(180, 28);
  assert.deepEqual(parseImageDimensions(vp8), { width: 320, height: 180 });
});

test('parseImageDimensions returns null for garbage or truncated input', () => {
  assert.equal(parseImageDimensions(Buffer.alloc(0)), null);
  assert.equal(parseImageDimensions(Buffer.from('not an image')), null);
  const truncatedPng = Buffer.alloc(8); // 只有魔数，读不到 IHDR
  truncatedPng.writeUInt32BE(0x89504e47, 0);
  truncatedPng.writeUInt32BE(0x0d0a1a0a, 4);
  assert.equal(parseImageDimensions(truncatedPng), null);
});
