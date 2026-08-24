import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const IMAGE_LIMITS = Object.freeze({
  maxImages: 30,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  maxDimension: 16_384,
  maxPixels: 40_000_000,
  maxRedirects: 4,
});

export const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inV4Range(address, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

export function isPublicIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4Range(address, base, bits));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return false;
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return false;
    if (normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return false;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isPublicIp(mapped) : true;
  }
  return false;
}

export async function resolvePublicHost(hostname, lookup = dns.lookup) {
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw Object.assign(new Error('IMAGE_SSRF_REJECTED'), { code: 'IMAGE_SSRF_REJECTED' });
    return { address: hostname, family: net.isIP(hostname) };
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => !isPublicIp(record.address))) {
    throw Object.assign(new Error('IMAGE_SSRF_REJECTED'), { code: 'IMAGE_SSRF_REJECTED' });
  }
  return records[0];
}

function dimensions(buffer, mimeType) {
  if (mimeType === 'image/png' && buffer.length >= 24) return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  if (mimeType === 'image/gif' && buffer.length >= 10) return [buffer.readUInt16LE(6), buffer.readUInt16LE(8)];
  if (mimeType === 'image/webp' && buffer.length >= 30 && buffer.subarray(12, 16).toString() === 'VP8X') {
    return [1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3)];
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return [buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5)];
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return null;
}

function sniffType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function validateImageBytes(buffer, mimeType, limits = IMAGE_LIMITS) {
  // 以魔数为准：野站常见扩展名/Content-Type 与实际字节不符（如 .png URL 发 JPEG），
  // 按声明类型解析尺寸会读出垃圾数值导致 DIMENSIONS 误杀
  const declared = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const sniffed = sniffType(buffer);
  const normalized = sniffed ?? declared;
  if (!ALLOWED_IMAGE_TYPES.has(normalized)) throw Object.assign(new Error('IMAGE_TYPE_REJECTED'), { code: 'IMAGE_TYPE_REJECTED' });
  if (!buffer.length || buffer.length > limits.maxImageBytes) throw Object.assign(new Error('IMAGE_SIZE_REJECTED'), { code: 'IMAGE_SIZE_REJECTED' });
  const size = dimensions(buffer, normalized);
  if (size && (Math.max(...size) > limits.maxDimension || size[0] * size[1] > limits.maxPixels)) {
    throw Object.assign(new Error('IMAGE_DIMENSIONS_REJECTED'), { code: 'IMAGE_DIMENSIONS_REJECTED' });
  }
  return { mimeType: normalized, extension: ALLOWED_IMAGE_TYPES.get(normalized), width: size?.[0] || null, height: size?.[1] || null };
}

export function pinnedLookup(record) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [record]);
    else callback(null, record.address, record.family);
  };
}

function requestOnce(url, record, limits) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: 'GET',
      headers: { Accept: 'image/jpeg,image/png,image/gif,image/webp', 'User-Agent': 'FeishuClip/0.1' },
      lookup: pinnedLookup(record),
      servername: url.hostname,
      timeout: 5_000,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url) });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(Object.assign(new Error(`IMAGE_HTTP_${response.statusCode}`), { code: 'IMAGE_FETCH_FAILED' }));
        return;
      }
      const advertised = Number(response.headers['content-length'] || 0);
      if (advertised > limits.maxImageBytes) {
        response.destroy();
        reject(Object.assign(new Error('IMAGE_SIZE_REJECTED'), { code: 'IMAGE_SIZE_REJECTED' }));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.setTimeout(10_000, () => response.destroy(new Error('IMAGE_RESPONSE_TIMEOUT')));
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > limits.maxImageBytes) response.destroy(Object.assign(new Error('IMAGE_SIZE_REJECTED'), { code: 'IMAGE_SIZE_REJECTED' }));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), mimeType: response.headers['content-type'] }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('IMAGE_CONNECT_TIMEOUT'), { code: 'IMAGE_FETCH_FAILED' })));
    request.on('error', reject);
    request.setTimeout(20_000, () => request.destroy(Object.assign(new Error('IMAGE_TOTAL_TIMEOUT'), { code: 'IMAGE_FETCH_FAILED' })));
    request.end();
  });
}

export async function downloadPublicImage(source, { limits = IMAGE_LIMITS, lookup = dns.lookup } = {}) {
  let url = new URL(source);
  for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('IMAGE_URL_REJECTED'), { code: 'IMAGE_URL_REJECTED' });
    const record = await resolvePublicHost(url.hostname, lookup);
    const result = await requestOnce(url, record, limits);
    if (result.redirect) { url = result.redirect; continue; }
    return { ...result, source: url.href, metadata: validateImageBytes(result.buffer, result.mimeType, limits) };
  }
  throw Object.assign(new Error('IMAGE_REDIRECT_LIMIT'), { code: 'IMAGE_FETCH_FAILED' });
}
