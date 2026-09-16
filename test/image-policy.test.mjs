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

// 边缘节点轮转（#92）：定IP（SSRF 钉孔）意味着重试总打同一个 CDN 边缘节点——
// 该节点被中间盒 RST 注入时全部重试都白搭。attempt 参数让重试换下一个 A 记录
test('resolvePublicHost：attempt 参数在多 A 记录间轮转，取模轮回', async () => {
  const records = [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];
  const lookup = async () => records;
  assert.equal((await resolvePublicHost('example.test', lookup)).address, '8.8.8.8', '默认第 0 条');
  assert.equal((await resolvePublicHost('example.test', lookup, 'IMAGE_SSRF_REJECTED', 1)).address, '1.1.1.1', '第 1 次重试换节点');
  assert.equal((await resolvePublicHost('example.test', lookup, 'IMAGE_SSRF_REJECTED', 2)).address, '8.8.8.8', '取模轮回到第 0 条');
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

// ——— PDF 下载策略（#65）：与图片同一套 SSRF/逐跳校验，差异只在 Accept/上限/超时 ———

import http from 'node:http';
import { assertPdfBytes, downloadPublicImage, downloadPublicPdf, requestPublicBytes } from '../src/bridge/image-policy.mjs';

const LOCAL_RECORD = { address: '127.0.0.1', family: 4 };

async function withHttpServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('requestPublicBytes: Content-Length 预检超限快速失败', async () => {
  let responded = 0;
  await withHttpServer((request, response) => {
    responded += 1;
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 4096 });
    response.end('%PDF-');
  }, async (base) => {
    await assert.rejects(
      () => requestPublicBytes(new URL(`${base}/big.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' }),
      /PDF_SIZE_REJECTED/,
    );
  });
  assert.equal(responded, 1, '预检失败直接断开，不重试');
});

test('requestPublicBytes: 无 Content-Length 时流式累计超限同样快速失败', async () => {
  await withHttpServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.write(Buffer.alloc(2048)); // 超过 maxBytes=1024
    response.end();
  }, async (base) => {
    await assert.rejects(
      () => requestPublicBytes(new URL(`${base}/chunked.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' }),
      /PDF_SIZE_REJECTED/,
    );
  });
});

test('requestPublicBytes: 正常响应带 buffer 与 content-type', async () => {
  await withHttpServer((request, response) => {
    assert.equal(request.headers.accept, 'application/pdf', 'PDF 通道用 PDF 的 Accept');
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.end('%PDF-1.7');
  }, async (base) => {
    const result = await requestPublicBytes(new URL(`${base}/ok.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' });
    assert.equal(result.buffer.toString('latin1'), '%PDF-1.7');
    assert.equal(result.mimeType, 'application/pdf');
  });
});

test('requestPublicBytes: 保留源站 WAF challenge 标记供浏览器回退判定', async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(202, { 'Content-Type': 'text/html', 'x-amzn-waf-action': 'challenge' });
    response.end('<html>challenge</html>');
  }, async (base) => {
    await assert.rejects(
      () => requestPublicBytes(new URL(`${base}/challenge`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' }),
      (error) => error.statusCode === 202 && error.challenge === true && error.failureType === 'http',
    );
  });
});

test('requestPublicBytes: 响应超时携带 transport 错误类型', async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.flushHeaders();
  }, async (base) => {
    await assert.rejects(
      () => requestPublicBytes(new URL(`${base}/slow.pdf`), LOCAL_RECORD, {
        accept: 'application/pdf', maxBytes: 1024, label: 'PDF',
        timeouts: { responseMs: 10, totalMs: 200 },
      }),
      (error) => /PDF_.*TIMEOUT/.test(error.message) && error.failureType === 'transport',
    );
  });
});

test('downloadPublicPdf 拒绝解析到私网地址的主机（PDF_SSRF_REJECTED）', async () => {
  const privateLookup = async () => [{ address: '10.0.0.8', family: 4 }];
  await assert.rejects(
    () => downloadPublicPdf('http://internal.example/paper.pdf', { lookup: privateLookup }),
    /PDF_SSRF_REJECTED/,
  );
  await assert.rejects(
    () => downloadPublicPdf('http://127.0.0.1/paper.pdf'),
    /PDF_SSRF_REJECTED/,
    '字面环回 IP 不经 DNS 也要被拒',
  );
});

test('downloadPublicPdf 拒绝非 http(s) 与带凭据的 URL', async () => {
  await assert.rejects(() => downloadPublicPdf('ftp://example.com/x.pdf'), /PDF_URL_REJECTED/);
  await assert.rejects(() => downloadPublicPdf('https://user:pass@example.com/x.pdf'), /PDF_URL_REJECTED/);
});

test('assertPdfBytes: %PDF- 魔数须在文件头 1024 字节内', () => {
  assert.doesNotThrow(() => assertPdfBytes(Buffer.from('%PDF-1.7\nbody', 'latin1')));
  assert.doesNotThrow(() => assertPdfBytes(Buffer.concat([Buffer.alloc(100), Buffer.from('%PDF-1.4', 'latin1')])), '规范允许魔数前有少量前导字节');
  assert.throws(() => assertPdfBytes(Buffer.from('<html><body>404</body></html>', 'latin1')), /PDF_TYPE_REJECTED/, 'HTML 错误页不得当 PDF');
  assert.throws(() => assertPdfBytes(Buffer.concat([Buffer.alloc(2000), Buffer.from('%PDF-', 'latin1')])), /PDF_TYPE_REJECTED/, '魔数超出 1024 字节窗口同样拒绝');
});

test('PDF 下载错误类型稳定区分 HTTP、内容、大小与 SSRF（#105）', async () => {
  await assert.rejects(
    () => resolvePublicHost('private.example', async () => [{ address: '10.0.0.8', family: 4 }], 'PDF_SSRF_REJECTED'),
    (error) => error.code === 'PDF_SSRF_REJECTED' && error.failureType === 'ssrf',
  );
  assert.throws(
    () => assertPdfBytes(Buffer.from('<html>not pdf</html>')),
    (error) => error.code === 'PDF_TYPE_REJECTED' && error.failureType === 'content',
  );
  await withHttpServer((_request, response) => {
    response.writeHead(404);
    response.end();
  }, async (base) => {
    await assert.rejects(
      () => requestPublicBytes(new URL(`${base}/missing.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' }),
      (error) => error.statusCode === 404 && error.failureType === 'http',
    );
  });
  await withHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 2048 });
    response.end('%PDF-');
  }, async (base) => {
    await assert.rejects(
      () => requestPublicBytes(new URL(`${base}/big.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' }),
      (error) => error.code === 'PDF_SIZE_REJECTED' && error.failureType === 'size',
    );
  });
});

test('downloadPublicPdf 通过用户配置的本地 HTTP 代理下载，并继续执行 PDF 校验（#106）', async () => {
  let requestedUrl = null;
  await withHttpServer((request, response) => {
    requestedUrl = request.url;
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.end('%PDF-1.7 proxied');
  }, async (proxyBase) => {
    const result = await downloadPublicPdf('http://papers.example/report.pdf', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      proxyPort: Number(new URL(proxyBase).port),
    });
    assert.equal(result.buffer.toString('latin1'), '%PDF-1.7 proxied');
    assert.equal(result.source, 'http://papers.example/report.pdf');
  });
  assert.equal(requestedUrl, 'http://8.8.8.8:80/report.pdf', '本地代理连接经过安全校验并钉住的 IP');
});

test('downloadPublicImage 复用本地代理并继续执行图片校验（#106）', async () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(2, 16);
  png.writeUInt32BE(3, 20);
  await withHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(png);
  }, async (proxyBase) => {
    const result = await downloadPublicImage('http://images.example/picture.png', {
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      proxyPort: Number(new URL(proxyBase).port),
    });
    assert.deepEqual(result.metadata, { mimeType: 'image/png', extension: 'png', width: 2, height: 3 });
  });
});

test('HTTPS 代理 CONNECT 后 TLS 握手停滞会按 transport 超时，而非永久挂起（#106）', async () => {
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (_request, socket) => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      () => requestPublicBytes(new URL('https://papers.example/report.pdf'), { address: '8.8.8.8', family: 4 }, {
        accept: 'application/pdf', maxBytes: 1024, label: 'PDF', proxyPort: proxy.address().port,
        timeouts: { connectMs: 30, responseMs: 50, totalMs: 100 },
      }),
      (error) => error.failureType === 'transport' && /PROXY_CONNECT_TIMEOUT/.test(error.message),
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

// ——— 按主机串行化信号量（#70）：同 host FIFO 单通道，不同 host 并行 ———

test('host 信号量：同 host 并发下载最大在飞为 1 且 FIFO 放行', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const arrivals = [];
  await withHttpServer((request, response) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    arrivals.push(request.url);
    setTimeout(() => {
      inFlight -= 1;
      response.writeHead(200, { 'Content-Type': 'application/pdf' });
      response.end('%PDF-');
    }, 30);
  }, async (base) => {
    const paths = ['/0.pdf', '/1.pdf', '/2.pdf', '/3.pdf', '/4.pdf'];
    await Promise.all(paths.map((path) => requestPublicBytes(new URL(`${base}${path}`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' })));
  });
  assert.equal(maxInFlight, 1, '同 host 单通道放行');
  assert.deepEqual(arrivals, ['/0.pdf', '/1.pdf', '/2.pdf', '/3.pdf', '/4.pdf'], '按发起顺序 FIFO 放行');
});

test('host 信号量：不同 host 并行不受限', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await withHttpServer((request, response) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      response.writeHead(200, { 'Content-Type': 'application/pdf' });
      response.end('%PDF-');
    }, 60);
  }, async (base) => {
    // 同一台服务器、两个 hostname 键（pinned lookup 无视主机名都回 127.0.0.1）
    const otherHost = base.replace('127.0.0.1', 'localhost');
    await Promise.all([
      requestPublicBytes(new URL(`${base}/a.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' }),
      requestPublicBytes(new URL(`${otherHost}/b.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' }),
    ]);
  });
  assert.equal(maxInFlight, 2, '不同 host 的在飞下载可重叠');
});

test('host 信号量：单请求 reject 后队列继续放行', async () => {
  await withHttpServer((request, response) => {
    if (request.url === '/boom.pdf') {
      response.writeHead(500);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.end('%PDF-');
  }, async (base) => {
    const [failure, success] = await Promise.allSettled([
      requestPublicBytes(new URL(`${base}/boom.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' }),
      requestPublicBytes(new URL(`${base}/ok.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' }),
    ]);
    assert.equal(failure.status, 'rejected');
    assert.match(failure.reason.message, /PDF_HTTP_500/);
    assert.equal(success.status, 'fulfilled', '前序请求失败在 finally 中释放槽位，后续请求照常完成');
  });
});

test('host 信号量：排队等待不计入单次下载超时', async () => {
  await withHttpServer((request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/pdf' });
      response.end('%PDF-');
    }, request.url === '/slow.pdf' ? 300 : 0);
  }, async (base) => {
    const slow = requestPublicBytes(new URL(`${base}/slow.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF' });
    // totalMs 远小于前序请求 300ms 的槽位占用：若排队等待计入超时，此请求必死于 TOTAL_TIMEOUT
    const queued = requestPublicBytes(new URL(`${base}/fast.pdf`), LOCAL_RECORD, { accept: 'application/pdf', maxBytes: 1024, label: 'PDF', timeouts: { totalMs: 100 } });
    const [, fast] = await Promise.all([slow, queued]);
    assert.equal(fast.buffer.toString('latin1'), '%PDF-');
  });
});
