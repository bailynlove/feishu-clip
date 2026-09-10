#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LarkClient } from './lark.mjs';
import { PairingStore } from './pairing.mjs';
import { IMAGE_MODES, JOB_KIND, JOB_STATUS, PDF_CHUNK_BYTES, PersistentJobStore } from './job-store.mjs';
import { PDF_LIMITS } from './image-policy.mjs';
import { PdfChunkStaging } from './pdf-chunks.mjs';
import { ClipExecutor } from './executor.mjs';

const JSON_LIMIT = 52 * 1024 * 1024;

function send(response, status, value, origin = null) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('JSON_REQUIRED'), { status: 415 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > JSON_LIMIT) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('INVALID_JSON'), { status: 400 }); }
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('SNAPSHOT_REQUIRED');
  const source = new URL(snapshot.sourceUrl);
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error('SOURCE_URL_REJECTED');
  if (!snapshot.title || !snapshot.markdown) throw new Error('SNAPSHOT_CONTENT_REQUIRED');
  if (snapshot.markdown.length > 1_500_000) throw new Error('SNAPSHOT_TOO_LARGE');
  if (snapshot.images && (!Array.isArray(snapshot.images) || snapshot.images.length > 30)) throw new Error('TOO_MANY_IMAGES');
  if (snapshot.iframes && (!Array.isArray(snapshot.iframes) || snapshot.iframes.length > 10)) throw new Error('TOO_MANY_IFRAMES');
}

// pdfSource（#65/#68）：url 型由 bridge 直接下载；bytes 型由扩展持凭据抓取后分块回传，
// 提交时声明文件名/总大小/总块数/SHA-256（#61）。name/sizeBytes 对 url 型是可选展示信息；
// 校验失败直接 400
function validatePdfSource(value) {
  const bad = (code) => Object.assign(new Error(code), { status: 400, code });
  if (!value || typeof value !== 'object' || (value.type !== 'url' && value.type !== 'bytes')) throw bad('PDF_SOURCE_REQUIRED');
  let url;
  try { url = new URL(value.url); } catch { throw bad('PDF_SOURCE_URL_REJECTED'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw bad('PDF_SOURCE_URL_REJECTED');
  const pdfSource = { type: value.type, url: url.href };
  if (value.name !== undefined && value.name !== null) {
    if (typeof value.name !== 'string' || value.name.length > 250) throw bad('PDF_SOURCE_INVALID');
    pdfSource.name = value.name;
  }
  if (value.sizeBytes !== undefined && value.sizeBytes !== null) {
    if (!Number.isInteger(value.sizeBytes) || value.sizeBytes <= 0) throw bad('PDF_SOURCE_INVALID');
    pdfSource.sizeBytes = value.sizeBytes;
  }
  if (value.type === 'bytes') {
    // bytes 声明是整验依据：文件名/总大小必填；总块数必须与 4 MiB 切块口径一致；
    // 大小上限与 url 型下载同一档（PDF_LIMITS.maxBytes），SHA-256 为小写 hex
    if (!pdfSource.name) throw bad('PDF_SOURCE_INVALID');
    if (pdfSource.sizeBytes === undefined) throw bad('PDF_SOURCE_INVALID');
    if (pdfSource.sizeBytes > PDF_LIMITS.maxBytes) throw bad('PDF_SOURCE_TOO_LARGE');
    const totalChunks = Math.ceil(pdfSource.sizeBytes / PDF_CHUNK_BYTES);
    if (value.totalChunks !== totalChunks) throw bad('PDF_SOURCE_INVALID');
    if (!/^[0-9a-f]{64}$/.test(value.sha256 || '')) throw bad('PDF_SOURCE_INVALID');
    pdfSource.totalChunks = totalChunks;
    pdfSource.sha256 = value.sha256;
  }
  return pdfSource;
}

function jobView(job) {
  if (!job) return null;
  const { snapshot: _snapshot, ...visible } = job;
  return visible;
}

// 扩展侧上报的提取耗时：只接受有限数，超界视为客户端时钟/版本异常，直接 400
function validateClientTiming(value) {
  if (value === undefined || value === null) return null;
  const extractMs = value?.extractMs;
  if (typeof extractMs !== 'number' || !Number.isFinite(extractMs) || extractMs < 0 || extractMs > 600_000) {
    throw Object.assign(new Error('clientTiming.extractMs 必须是 0-600000 的有限数'), { status: 400, code: 'CLIENT_TIMING_INVALID' });
  }
  return { extractMs };
}

const WIKI_TOKEN = /^[0-9A-Za-z_-]{1,64}$/;
const MAX_CURSOR_LENGTH = 512;

function parseTargetQuery(request, allowedKeys) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const query = url.searchParams;
  for (const key of query.keys()) {
    if (!allowedKeys.includes(key)) throw Object.assign(new Error(`未知查询参数：${key}`), { status: 400, code: 'TARGET_QUERY_INVALID' });
  }
  const cursor = query.get('cursor');
  if (cursor !== null && (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || cursor.includes('\0'))) {
    throw Object.assign(new Error('分页 cursor 不合法'), { status: 400, code: 'TARGET_QUERY_INVALID' });
  }
  let limit = 50;
  if (query.get('limit') !== null) {
    limit = Number(query.get('limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Object.assign(new Error('limit 必须是 1-50 的整数'), { status: 400, code: 'TARGET_QUERY_INVALID' });
  }
  return { pathname: url.pathname, cursor: cursor || undefined, limit, query };
}

function larkQueryError(error, resource = '知识库') {
  const text = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  if (/auth|login|unauthorized|token.{0,12}(expired|invalid)|登录|授权/.test(text)) return { status: 503, code: 'LARK_AUTH_REQUIRED', message: '飞书用户未登录或授权已失效' };
  if (/permission|forbidden|denied|权限/.test(text)) return { status: 403, code: 'LARK_PERMISSION_DENIED', message: `当前飞书用户没有访问该${resource}的权限` };
  return { status: 502, code: 'LARK_REQUEST_FAILED', message: '飞书查询失败，请稍后重试' };
}

export async function createBridge({ config, lark = new LarkClient({ cliPath: config.larkCliPath }), logger = console, downloadPdf }) {
  const pairing = new PairingStore(config.pairingFile);
  const store = new PersistentJobStore({ filePath: config.jobFile, jobTtlMs: config.jobTtlMs });
  // 分块暂存（#68）：staging 目录在 job 文件旁，executor 与分块端点共用同一实例
  const staging = new PdfChunkStaging({ dir: path.join(path.dirname(config.jobFile), 'staging') });
  const executor = new ClipExecutor({ store, lark, logger, staging, ...(downloadPdf ? { downloadPdf } : {}) });
  // 过期恢复 + 建档歧义查证（reconcile）+ 消费队列：启动时跑一遍，之后周期 sweep，
  // reconciling 任务不再依赖 bridge 重启才能被捞起（#51）。unref 不拖进程退出。
  // staging 清理（#68）：随 recoverExpired 的 expired 列表即时 discard，再按 mtime 扫超龄孤儿
  const sweep = async () => {
    const recovered = await store.recoverExpired();
    for (const attemptId of recovered.expired) await staging.discard(attemptId).catch(() => {});
    await staging.sweep(config.jobTtlMs ?? 24 * 60 * 60 * 1_000).catch((error) => logger.error('staging sweep failed', error));
    await executor.reconcile();
    executor.kick();
  };
  await sweep();
  const sweepTimer = setInterval(() => {
    sweep().catch((error) => logger.error('periodic sweep failed', error));
  }, config.sweepIntervalMs ?? 10 * 60_000);
  sweepTimer.unref();

  const server = createServer(async (request, response) => {
    const origin = String(request.headers.origin || '');
    try {
      if (request.method === 'OPTIONS') {
        if (!pairing.validOrigin(origin)) return send(response, 403, { ok: false, code: 'ORIGIN_MISMATCH' });
        response.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Feishu-Clip-Origin',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        });
        response.end();
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/pair') {
        const body = await readJson(request);
        const result = await pairing.pair(origin, body.code);
        return send(response, result.ok ? 200 : 401, result, pairing.validOrigin(origin) ? origin : null);
      }

      const claimedOrigin = String(request.headers['x-feishu-clip-origin'] || '');
      if (origin && claimedOrigin && origin !== claimedOrigin) {
        return send(response, 401, { ok: false, code: 'ORIGIN_MISMATCH' }, pairing.validOrigin(origin) ? origin : null);
      }
      const effectiveOrigin = origin || claimedOrigin;
      const credential = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const auth = await pairing.authorize(effectiveOrigin, credential);
      if (!auth.ok) return send(response, 401, { ok: false, code: auth.code }, pairing.validOrigin(origin) ? origin : null);

      if (request.method === 'GET' && request.url === '/v1/status') {
        let larkAuth;
        try { larkAuth = await lark.authStatus(); }
        catch (error) { larkAuth = { ready: false, error: error.code || error.message }; }
        return send(response, 200, { ok: true, version: config.version, pid: process.pid, address: config.host, larkAuth }, origin);
      }

      if (request.method === 'POST' && request.url === '/v1/destinations/validate') {
        const body = await readJson(request);
        if (!body.nodeToken && !body.spaceId) return send(response, 400, { ok: false, code: 'DESTINATION_REQUIRED' }, origin);
        try {
          const destination = await lark.validateDestination(body);
          return send(response, 200, { ok: true, destination }, origin);
        } catch (error) {
          return send(response, 422, { ok: false, code: 'INVALID_TARGET', message: error.message }, origin);
        }
      }

      if (request.method === 'GET' && request.url?.startsWith('/v1/targets/spaces')) {
        const { pathname, cursor, limit } = parseTargetQuery(request, ['cursor', 'limit']);
        if (pathname !== '/v1/targets/spaces') return send(response, 404, { ok: false, code: 'NOT_FOUND' }, origin);
        try {
          const result = await lark.listSpaces({ pageToken: cursor, pageSize: limit });
          return send(response, 200, { ok: true, ...result }, origin);
        } catch (error) {
          const mapped = larkQueryError(error);
          return send(response, mapped.status, { ok: false, code: mapped.code, message: mapped.message }, origin);
        }
      }

      if (request.method === 'GET' && request.url?.startsWith('/v1/targets/nodes')) {
        const { pathname, cursor, limit, query } = parseTargetQuery(request, ['spaceId', 'parentNodeToken', 'cursor', 'limit']);
        if (pathname !== '/v1/targets/nodes') return send(response, 404, { ok: false, code: 'NOT_FOUND' }, origin);
        const spaceId = query.get('spaceId');
        const parentNodeToken = query.get('parentNodeToken');
        if (!spaceId || !WIKI_TOKEN.test(spaceId)) return send(response, 400, { ok: false, code: 'TARGET_QUERY_INVALID', message: 'spaceId 不合法' }, origin);
        if (parentNodeToken !== null && !WIKI_TOKEN.test(parentNodeToken)) return send(response, 400, { ok: false, code: 'TARGET_QUERY_INVALID', message: 'parentNodeToken 不合法' }, origin);
        try {
          const result = await lark.listNodes({ spaceId, parentNodeToken: parentNodeToken || undefined, pageToken: cursor, pageSize: limit });
          return send(response, 200, { ok: true, ...result }, origin);
        } catch (error) {
          const mapped = larkQueryError(error);
          return send(response, mapped.status, { ok: false, code: mapped.code, message: mapped.message }, origin);
        }
      }

      // Drive 目录选择器端点族（#66）：省略 parentFolderToken 即根层「我的空间」，只返回文件夹项
      if (request.method === 'GET' && request.url?.startsWith('/v1/drive/folders')) {
        const { pathname, cursor, limit, query } = parseTargetQuery(request, ['parentFolderToken', 'cursor', 'limit']);
        if (pathname !== '/v1/drive/folders') return send(response, 404, { ok: false, code: 'NOT_FOUND' }, origin);
        const parentFolderToken = query.get('parentFolderToken');
        if (parentFolderToken !== null && !WIKI_TOKEN.test(parentFolderToken)) return send(response, 400, { ok: false, code: 'TARGET_QUERY_INVALID', message: 'parentFolderToken 不合法' }, origin);
        try {
          const result = await lark.listDriveFolders({ folderToken: parentFolderToken || undefined, pageToken: cursor, pageSize: limit });
          return send(response, 200, { ok: true, ...result }, origin);
        } catch (error) {
          const mapped = larkQueryError(error, '云盘目录');
          return send(response, mapped.status, { ok: false, code: mapped.code, message: mapped.message }, origin);
        }
      }

      // 目录校验（picker 保存/手贴 token 共用）：folderToken 缺失/null 表示云盘根目录，合法通过
      if (request.method === 'POST' && request.url === '/v1/drive/folders/validate') {
        const body = await readJson(request);
        const folderToken = body?.folderToken;
        if (folderToken !== undefined && folderToken !== null && (typeof folderToken !== 'string' || !WIKI_TOKEN.test(folderToken))) {
          return send(response, 400, { ok: false, code: 'FOLDER_TOKEN_INVALID', message: 'folderToken 不合法' }, origin);
        }
        try {
          const folder = await lark.validateDriveFolder({ folderToken: folderToken || null });
          return send(response, 200, { ok: true, folder }, origin);
        } catch (error) {
          return send(response, 422, { ok: false, code: 'INVALID_TARGET', message: error.message }, origin);
        }
      }

      if (request.method === 'GET' && request.url?.startsWith('/v1/jobs') && !request.url.startsWith('/v1/jobs/')) {
        const { pathname, query, limit: parsedLimit } = parseTargetQuery(request, ['limit']);
        if (pathname !== '/v1/jobs') return send(response, 404, { ok: false, code: 'NOT_FOUND' }, origin);
        // parseTargetQuery 的默认 limit 是 50（targets 端点约定），任务列表默认 20
        const limit = query.get('limit') === null ? 20 : parsedLimit;
        // 任务列表给排查耗时用：新的在前，剥掉 snapshot 全文，只留标题与耗时字段
        const jobs = (await store.list()).reverse().slice(0, limit).map((job) => ({
          ...jobView(job),
          title: typeof job.snapshot?.title === 'string' ? job.snapshot.title : (job.title ?? null),
          timeline: job.timeline ?? [],
          totalMs: job.totalMs ?? null,
          clientTiming: job.clientTiming ?? null,
        }));
        return send(response, 200, { ok: true, jobs }, origin);
      }

      if (request.method === 'POST' && request.url === '/v1/jobs') {
        const body = await readJson(request);
        // pdf-only 提交（#67：PDF 标签页场景）：无 snapshot/destination，只校验 attemptId +
        // pdfSource + 目标目录，落一条 pdf job；下方 clip 语义路径（snapshot/destination 校验）保持不变
        if (body.snapshot === undefined || body.snapshot === null) {
          if (!body.attemptId) return send(response, 400, { ok: false, code: 'JOB_INPUT_REQUIRED' }, origin);
          const pdfSource = validatePdfSource(body.pdfSource);
          const pdfFolderToken = body.pdfFolderToken === undefined || body.pdfFolderToken === null ? null : body.pdfFolderToken;
          if (pdfFolderToken !== null && (typeof pdfFolderToken !== 'string' || !WIKI_TOKEN.test(pdfFolderToken))) {
            return send(response, 400, { ok: false, code: 'PDF_FOLDER_INVALID', message: 'pdfFolderToken 不合法' }, origin);
          }
          // sourceUrl 取 PDF 地址本身：弹窗按它做同页 job 恢复（isJobForPage）
          const submitted = await store.submit({
            attemptId: body.attemptId,
            sourceUrl: pdfSource.url,
            kind: JOB_KIND.PDF,
            pdfSource,
            title: typeof body.title === 'string' && body.title ? body.title : null,
            folderToken: pdfFolderToken,
          });
          executor.kick();
          return send(response, submitted.created ? 202 : 200, { ok: true, created: submitted.created, job: null, pdfJob: jobView(submitted.job) }, origin);
        }
        const isSpaceTarget = body.destination?.kind === 'space';
        if (!body.attemptId || !(isSpaceTarget ? body.destination?.spaceId : body.destination?.nodeToken)) return send(response, 400, { ok: false, code: 'JOB_INPUT_REQUIRED' }, origin);
        validateSnapshot(body.snapshot);
        const clientTiming = validateClientTiming(body.clientTiming);
        const pdfSource = body.pdfSource === undefined || body.pdfSource === null ? null : validatePdfSource(body.pdfSource);
        // pdf 目标目录（#66）：null = 云盘根目录；非空须是合法 token 形态
        const pdfFolderToken = body.pdfFolderToken === undefined || body.pdfFolderToken === null ? null : body.pdfFolderToken;
        if (pdfFolderToken !== null && (typeof pdfFolderToken !== 'string' || !WIKI_TOKEN.test(pdfFolderToken))) {
          return send(response, 400, { ok: false, code: 'PDF_FOLDER_INVALID', message: 'pdfFolderToken 不合法' }, origin);
        }
        try { await lark.validateDestination(body.destination); }
        catch (error) { return send(response, 422, { ok: false, code: 'INVALID_TARGET', message: error.message }, origin); }
        // 图片写入模式（#53）：合法三态直用；非法/缺省回退旧 includeImages 布尔语义（false → off，其余 → preview）
        const imageMode = IMAGE_MODES.includes(body.imageMode) ? body.imageMode : (body.includeImages === false ? 'off' : 'preview');
        const submitted = await store.submit({
          attemptId: body.attemptId,
          sourceUrl: body.snapshot.sourceUrl,
          snapshot: body.snapshot,
          destination: body.destination,
          includeImages: imageMode !== 'off',
          imageMode,
          clientTiming,
        });
        // 双 job（#60/#65）：同一 attemptId 附带 pdf job，title 用渲染后的快照标题做云盘文件命名；
        // folderToken（#66）是 picker/弹窗选定的云盘目录，null 即根目录
        let pdfSubmitted = null;
        if (pdfSource) {
          pdfSubmitted = await store.submit({
            attemptId: body.attemptId,
            sourceUrl: body.snapshot.sourceUrl,
            kind: JOB_KIND.PDF,
            pdfSource,
            title: body.snapshot.title,
            folderToken: pdfFolderToken,
          });
        }
        executor.kick();
        return send(response, submitted.created ? 202 : 200, { ok: true, created: submitted.created, job: jobView(submitted.job), pdfJob: pdfSubmitted ? jobView(pdfSubmitted.job) : null }, origin);
      }

      // ——— 分块通道（#61/#68）：扩展凭据回传 PDF 字节 ———
      // GET 返回已收块位图（续传断点）；POST 写一块（4 MiB 原字节 base64 + index）。
      // 全部到齐 + 整文件 SHA-256 验证通过 → job 转 queued（executor 走 staging 上传）；
      // hash 不匹配 → 422 + job failed + 清理 staging。端点只服务 awaiting_bytes 的 pdf job
      const chunksMatch = request.url?.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/pdf-chunks$/i);
      if (chunksMatch && request.method === 'GET') {
        const job = await store.get(chunksMatch[1], JOB_KIND.PDF);
        if (!job) return send(response, 404, { ok: false, code: 'JOB_NOT_FOUND' }, origin);
        if (job.status !== JOB_STATUS.AWAITING_BYTES) return send(response, 409, { ok: false, code: 'PDF_BYTES_NOT_EXPECTED' }, origin);
        // declared=false 表示 url 型回退尚未补交 bytes 声明（扩展先做声明再喂块）
        const declared = job.pdfSource?.type === 'bytes' ? job.pdfSource : null;
        return send(response, 200, {
          ok: true,
          declared: Boolean(declared),
          totalChunks: declared?.totalChunks ?? null,
          sizeBytes: declared?.sizeBytes ?? null,
          bitmap: await staging.bitmap(job.attemptId),
        }, origin);
      }
      if (chunksMatch && request.method === 'POST') {
        const job = await store.get(chunksMatch[1], JOB_KIND.PDF);
        if (!job) return send(response, 404, { ok: false, code: 'JOB_NOT_FOUND' }, origin);
        if (job.status !== JOB_STATUS.AWAITING_BYTES) return send(response, 409, { ok: false, code: 'PDF_BYTES_NOT_EXPECTED' }, origin);
        const declared = job.pdfSource?.type === 'bytes' ? job.pdfSource : null;
        if (!declared) return send(response, 409, { ok: false, code: 'PDF_BYTES_NOT_DECLARED' }, origin);
        const body = await readJson(request);
        const bad = (code) => Object.assign(new Error(code), { status: 400, code });
        if (!Number.isInteger(body?.index) || body.index < 0 || body.index >= declared.totalChunks) throw bad('PDF_CHUNK_INVALID');
        if (body.totalChunks !== declared.totalChunks) throw bad('PDF_CHUNK_INVALID');
        if (typeof body.dataBase64 !== 'string') throw bad('PDF_CHUNK_INVALID');
        const buffer = Buffer.from(body.dataBase64, 'base64');
        // 每块必须恰为声明口径：非末块 4 MiB 满块，末块 = 总大小 − 偏移
        const expectedBytes = body.index === declared.totalChunks - 1
          ? declared.sizeBytes - body.index * PDF_CHUNK_BYTES
          : PDF_CHUNK_BYTES;
        if (buffer.length !== expectedBytes || buffer.length < 1) throw bad('PDF_CHUNK_INVALID');
        const bitmap = await staging.putChunk(job.attemptId, body.index, buffer);
        if (bitmap.length < declared.totalChunks) {
          return send(response, 200, { ok: true, complete: false, received: bitmap.length, totalChunks: declared.totalChunks, bitmap }, origin);
        }
        try {
          await staging.verify(job.attemptId, declared);
        } catch {
          // 整验失败：拒收——job failed、staging 清理，不产生云盘文件
          await staging.discard(job.attemptId);
          await store.failBytes(job.attemptId, 'PDF 字节校验失败（SHA-256 不匹配），已拒绝接收');
          return send(response, 422, { ok: false, code: 'PDF_HASH_MISMATCH' }, origin);
        }
        await store.markBytesReady(job.attemptId);
        executor.kick();
        return send(response, 200, { ok: true, complete: true, received: bitmap.length, totalChunks: declared.totalChunks }, origin);
      }

      const match = request.method === 'GET' && request.url?.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/i);
      if (match) {
        // get(attemptId) 语义升为「一次尝试」（#60）：返回该 attempt 的全部 job，弹窗侧做聚合呈现
        const jobs = await store.get(match[1]);
        return jobs.length
          ? send(response, 200, { ok: true, jobs: jobs.map(jobView) }, origin)
          : send(response, 404, { ok: false, code: 'JOB_NOT_FOUND' }, origin);
      }

      return send(response, 404, { ok: false, code: 'NOT_FOUND' }, origin);
    } catch (error) {
      logger.error('request failed', error);
      return send(response, error.status || 400, { ok: false, code: error.code || error.message || 'BAD_REQUEST' }, pairing.validOrigin(origin) ? origin : null);
    }
  });

  return { server, store, executor };
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: node server.mjs /path/to/bridge.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.host !== '127.0.0.1') throw new Error('Bridge must bind 127.0.0.1');
  const { server } = await createBridge({ config });
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'listening', host: config.host, port: config.port, pid: process.pid })));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((error) => { console.error(error); process.exit(1); });
