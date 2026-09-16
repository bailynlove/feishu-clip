import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

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

export const RESOURCE_FAILURE_TYPE = Object.freeze({
  TRANSPORT: 'transport',
  HTTP: 'http',
  CONTENT: 'content',
  SIZE: 'size',
  SSRF: 'ssrf',
});

function resourceError(message, code, failureType, details = {}) {
  return Object.assign(new Error(message), { code, failureType, ...details });
}

function classifyError(error, failureType) {
  if (error && typeof error === 'object') {
    error.failureType ??= failureType;
    return error;
  }
  return resourceError(String(error), 'RESOURCE_FETCH_FAILED', failureType);
}

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

export async function resolvePublicHost(hostname, lookup = dns.lookup, code = 'IMAGE_SSRF_REJECTED', attempt = 0) {
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw resourceError(code, code, RESOURCE_FAILURE_TYPE.SSRF);
    return { address: hostname, family: net.isIP(hostname) };
  }
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw classifyError(error, RESOURCE_FAILURE_TYPE.TRANSPORT);
  }
  if (!records.length || records.some((record) => !isPublicIp(record.address))) {
    throw resourceError(code, code, RESOURCE_FAILURE_TYPE.SSRF);
  }
  // 边缘节点轮转（#92）：钉孔固定单一 IP，重试打同一个被 RST 注入的 CDN 边缘会全部白费；
  // attempt 取模让每次重试换下一个 A 记录（与浏览器/curl 的 try-next-address 行为对齐）
  return records[attempt % records.length];
}

function dimensions(buffer, mimeType) {
  if (mimeType === 'image/png' && buffer.length >= 24) return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  if (mimeType === 'image/gif' && buffer.length >= 10) return [buffer.readUInt16LE(6), buffer.readUInt16LE(8)];
  if (mimeType === 'image/webp' && buffer.length >= 30) {
    const chunk = buffer.subarray(12, 16).toString('latin1');
    // VP8X（扩展格式）：宽高各 3 字节小端、存的是减 1
    if (chunk === 'VP8X') return [1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3)];
    // VP8L（无损）：0x2f 签名后 4 字节小端位打包，宽低 14 位、高次 14 位、各存减 1
    if (chunk === 'VP8L' && buffer[20] === 0x2f) {
      const packed = buffer.readUInt32LE(21);
      return [(packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1];
    }
    // VP8（有损）：3 字节帧标签后是 0x9d012a 起始码，宽高 14 位小端（高 2 位为缩放位）
    if (chunk === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return [buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff];
    }
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

// 建图片块需要原始宽高（飞书 replace_image 不重算尺寸，空块固定 100x100）。
// 以魔数为准手工解析四种格式的头部；识别不出或头被截断返回 null，调用方留空 image 对象
export function parseImageDimensions(buffer) {
  const type = sniffType(buffer);
  if (!type) return null;
  const size = dimensions(buffer, type);
  return size ? { width: size[0], height: size[1] } : null;
}

export function validateImageBytes(buffer, mimeType, limits = IMAGE_LIMITS) {
  // 以魔数为准：野站常见扩展名/Content-Type 与实际字节不符（如 .png URL 发 JPEG），
  // 按声明类型解析尺寸会读出垃圾数值导致 DIMENSIONS 误杀
  const declared = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const sniffed = sniffType(buffer);
  const normalized = sniffed ?? declared;
  if (!ALLOWED_IMAGE_TYPES.has(normalized)) throw resourceError('IMAGE_TYPE_REJECTED', 'IMAGE_TYPE_REJECTED', RESOURCE_FAILURE_TYPE.CONTENT);
  if (!buffer.length || buffer.length > limits.maxImageBytes) throw resourceError('IMAGE_SIZE_REJECTED', 'IMAGE_SIZE_REJECTED', RESOURCE_FAILURE_TYPE.SIZE);
  const size = dimensions(buffer, normalized);
  if (size && (Math.max(...size) > limits.maxDimension || size[0] * size[1] > limits.maxPixels)) {
    throw resourceError('IMAGE_DIMENSIONS_REJECTED', 'IMAGE_DIMENSIONS_REJECTED', RESOURCE_FAILURE_TYPE.SIZE);
  }
  return { mimeType: normalized, extension: ALLOWED_IMAGE_TYPES.get(normalized), width: size?.[0] || null, height: size?.[1] || null };
}

export function pinnedLookup(record) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [record]);
    else callback(null, record.address, record.family);
  };
}

// 按主机串行化信号量（#70）：arXiv 等站点限制同 IP 并发连接数，双 job 并发同主机下载会
// 撞出 ECONNRESET。同 hostname 的下载 FIFO 排队、单通道放行；不同 host 并行不受限。
// 槽位授予后才创建 request（connect/response/total 计时都从 request 创建起算），
// 因此排队等待不计入单次下载超时；槽位由调用方在 finally 中释放，单请求失败不堵队列。
// 队列不设上限——每 host 深度天然有限（图片 ≤30/篇 + PDF 1 份），失控由 job 级 lease/TTL 兜底
const hostTails = new Map();

function acquireHostSlot(hostname) {
  const tail = hostTails.get(hostname) ?? Promise.resolve();
  let release;
  const slot = new Promise((resolve) => { release = resolve; });
  const next = tail.then(() => slot);
  hostTails.set(hostname, next);
  // 链尾 settle 后若无人接续则清表，避免一次性 host 在 Map 里累积
  next.then(() => { if (hostTails.get(hostname) === next) hostTails.delete(hostname); });
  return tail.then(() => release);
}

// 带 SSRF 钉孔（pinned lookup）的单次 GET：Content-Length 预检 + 流式字节累计双重超限快速失败。
// label 决定错误码前缀（IMAGE_*/PDF_*）；record 由 resolvePublicHost 给出，逐跳重解析。
// 图片与 PDF 两条下载路径都收口在这里，按主机信号量因此自动覆盖两条路径（重定向每跳重进、按各跳 host 排队）
function authority(address, port) {
  return `${net.isIPv6(address) ? `[${address}]` : address}:${port}`;
}

class PinnedHttpsProxyAgent extends https.Agent {
  constructor({ proxyPort, address, targetPort, servername, connectMs }) {
    super({ keepAlive: false });
    Object.assign(this, { proxyPort, address, targetPort, servername, connectMs });
  }

  createConnection(options, callback) {
    let settled = false;
    let secure;
    const timeoutError = () => resourceError('PROXY_CONNECT_TIMEOUT', 'RESOURCE_FETCH_FAILED', RESOURCE_FAILURE_TYPE.TRANSPORT);
    const timer = setTimeout(() => {
      const error = timeoutError();
      secure?.destroy(error);
      tunnel.destroy(error);
      done(error);
    }, this.connectMs);
    timer.unref();
    const done = (error, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(error, socket);
    };
    const tunnel = http.request({
      hostname: '127.0.0.1', port: this.proxyPort, method: 'CONNECT',
      path: authority(this.address, this.targetPort),
      headers: { Host: authority(this.address, this.targetPort) },
    });
    tunnel.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        done(new Error(`PROXY_CONNECT_HTTP_${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      secure = tls.connect({ ...options, socket, servername: this.servername });
      secure.once('secureConnect', () => done(null, secure));
      secure.once('error', done);
    });
    tunnel.once('error', done);
    tunnel.end();
    return undefined;
  }
}

export function requestPublicBytes(url, record, { accept, maxBytes, label, timeouts = {}, proxyPort = null }) {
  const { connectMs = 5_000, responseMs = 10_000, totalMs = 20_000 } = timeouts;
  let client = url.protocol === 'https:' ? https : http;
  let target = { protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}` };
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  let agent;
  if (proxyPort && url.protocol === 'http:') {
    client = http;
    const port = Number(url.port || 80);
    target = {
      hostname: '127.0.0.1', port: proxyPort,
      path: `http://${authority(record.address, port)}${url.pathname}${url.search}`,
    };
  } else if (proxyPort) {
    agent = new PinnedHttpsProxyAgent({ proxyPort, address: record.address, targetPort: Number(url.port || 443), servername: url.hostname, connectMs });
  }
  return acquireHostSlot(url.hostname).then((release) => new Promise((resolve, reject) => {
    const request = client.request({ ...target,
      method: 'GET',
      headers: { Accept: accept, Host: host, 'User-Agent': 'FeishuClip/0.1' },
      lookup: pinnedLookup(record),
      servername: url.hostname,
      timeout: connectMs,
      agent,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url) });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        // statusCode 与 WAF 标记透传给调用方：需要浏览器会话的响应转凭据回退，
        // 由扩展让用户在可见窗口完成验证，而不是把挑战页当成普通下载失败。
        reject(resourceError(`${label}_HTTP_${response.statusCode}`, `${label}_FETCH_FAILED`, RESOURCE_FAILURE_TYPE.HTTP, {
          statusCode: response.statusCode,
          challenge: String(response.headers['x-amzn-waf-action'] || '').toLowerCase() === 'challenge',
          contentType: response.headers['content-type'] || null,
        }));
        return;
      }
      const advertised = Number(response.headers['content-length'] || 0);
      if (advertised > maxBytes) {
        response.destroy();
        reject(resourceError(`${label}_SIZE_REJECTED`, `${label}_SIZE_REJECTED`, RESOURCE_FAILURE_TYPE.SIZE));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.setTimeout(responseMs, () => response.destroy(resourceError(`${label}_RESPONSE_TIMEOUT`, `${label}_FETCH_FAILED`, RESOURCE_FAILURE_TYPE.TRANSPORT)));
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) response.destroy(resourceError(`${label}_SIZE_REJECTED`, `${label}_SIZE_REJECTED`, RESOURCE_FAILURE_TYPE.SIZE));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), mimeType: response.headers['content-type'] }));
      response.on('error', (error) => reject(classifyError(error, RESOURCE_FAILURE_TYPE.TRANSPORT)));
    });
    request.on('timeout', () => request.destroy(resourceError(`${label}_CONNECT_TIMEOUT`, `${label}_FETCH_FAILED`, RESOURCE_FAILURE_TYPE.TRANSPORT)));
    request.on('error', (error) => reject(classifyError(error, RESOURCE_FAILURE_TYPE.TRANSPORT)));
    request.setTimeout(totalMs, () => request.destroy(resourceError(`${label}_TOTAL_TIMEOUT`, `${label}_FETCH_FAILED`, RESOURCE_FAILURE_TYPE.TRANSPORT)));
    request.end();
  }).finally(release));
}

export async function downloadPublicImage(source, { limits = IMAGE_LIMITS, lookup = dns.lookup, attempt = 0, proxyPort = null } = {}) {
  let url = new URL(source);
  for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw resourceError('IMAGE_URL_REJECTED', 'IMAGE_URL_REJECTED', RESOURCE_FAILURE_TYPE.SSRF);
    const record = await resolvePublicHost(url.hostname, lookup, 'IMAGE_SSRF_REJECTED', attempt);
    const result = await requestPublicBytes(url, record, { accept: 'image/jpeg,image/png,image/gif,image/webp', maxBytes: limits.maxImageBytes, label: 'IMAGE', proxyPort });
    if (result.redirect) { url = result.redirect; continue; }
    return { ...result, source: url.href, metadata: validateImageBytes(result.buffer, result.mimeType, limits) };
  }
  throw resourceError('IMAGE_REDIRECT_LIMIT', 'IMAGE_FETCH_FAILED', RESOURCE_FAILURE_TYPE.HTTP);
}

// PDF 下载（#65）：与图片管线同一套 SSRF/逐跳校验，差异只在 Accept、上限与超时档位。
// 大小硬上限 100 MiB：远低于分片档租户限额（认证后 10 GB 起，#57 事实），目的是把失控下载
// 挡在 Bridge 本地；租户档位收紧时下调此常量即可
export const PDF_LIMITS = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  maxRedirects: 4,
});

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

// 魔数校验（PDF 规范允许 %PDF- 出现在文件头 1024 字节内）：200 但回的是 HTML 错误页时
// 快速失败，不把垃圾当 PDF 传进云盘
export function assertPdfBytes(buffer) {
  if (!buffer.subarray(0, 1024).includes(PDF_MAGIC)) {
    throw resourceError('PDF_TYPE_REJECTED', 'PDF_TYPE_REJECTED', RESOURCE_FAILURE_TYPE.CONTENT);
  }
}

export async function downloadPublicPdf(source, { limits = PDF_LIMITS, lookup = dns.lookup, attempt = 0, proxyPort = null } = {}) {
  let url = new URL(source);
  for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw resourceError('PDF_URL_REJECTED', 'PDF_URL_REJECTED', RESOURCE_FAILURE_TYPE.SSRF);
    const record = await resolvePublicHost(url.hostname, lookup, 'PDF_SSRF_REJECTED', attempt);
    const result = await requestPublicBytes(url, record, {
      accept: 'application/pdf',
      maxBytes: limits.maxBytes,
      label: 'PDF',
      timeouts: { connectMs: 15_000, responseMs: 30_000, totalMs: 120_000 },
      proxyPort,
    });
    if (result.redirect) { url = result.redirect; continue; }
    assertPdfBytes(result.buffer);
    return { buffer: result.buffer, source: url.href, sizeBytes: result.buffer.length };
  }
  throw resourceError('PDF_REDIRECT_LIMIT', 'PDF_FETCH_FAILED', RESOURCE_FAILURE_TYPE.HTTP);
}
