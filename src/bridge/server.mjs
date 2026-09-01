#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { LarkClient } from './lark.mjs';
import { PairingStore } from './pairing.mjs';
import { PersistentJobStore } from './job-store.mjs';
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

function larkQueryError(error) {
  const text = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  if (/auth|login|unauthorized|token.{0,12}(expired|invalid)|登录|授权/.test(text)) return { status: 503, code: 'LARK_AUTH_REQUIRED', message: '飞书用户未登录或授权已失效' };
  if (/permission|forbidden|denied|权限/.test(text)) return { status: 403, code: 'LARK_PERMISSION_DENIED', message: '当前飞书用户没有访问该知识库的权限' };
  return { status: 502, code: 'LARK_REQUEST_FAILED', message: '飞书查询失败，请稍后重试' };
}

export async function createBridge({ config, lark = new LarkClient({ cliPath: config.larkCliPath }), logger = console }) {
  const pairing = new PairingStore(config.pairingFile);
  const store = new PersistentJobStore({ filePath: config.jobFile });
  const executor = new ClipExecutor({ store, lark, logger });
  await store.recoverExpired();
  executor.kick();

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

      if (request.method === 'GET' && request.url?.startsWith('/v1/jobs') && !request.url.startsWith('/v1/jobs/')) {
        const { pathname, query, limit: parsedLimit } = parseTargetQuery(request, ['limit']);
        if (pathname !== '/v1/jobs') return send(response, 404, { ok: false, code: 'NOT_FOUND' }, origin);
        // parseTargetQuery 的默认 limit 是 50（targets 端点约定），任务列表默认 20
        const limit = query.get('limit') === null ? 20 : parsedLimit;
        // 任务列表给排查耗时用：新的在前，剥掉 snapshot 全文，只留标题与耗时字段
        const jobs = (await store.list()).reverse().slice(0, limit).map((job) => ({
          ...jobView(job),
          title: typeof job.snapshot?.title === 'string' ? job.snapshot.title : null,
          timeline: job.timeline ?? [],
          totalMs: job.totalMs ?? null,
          clientTiming: job.clientTiming ?? null,
        }));
        return send(response, 200, { ok: true, jobs }, origin);
      }

      if (request.method === 'POST' && request.url === '/v1/jobs') {
        const body = await readJson(request);
        const isSpaceTarget = body.destination?.kind === 'space';
        if (!body.attemptId || !(isSpaceTarget ? body.destination?.spaceId : body.destination?.nodeToken)) return send(response, 400, { ok: false, code: 'JOB_INPUT_REQUIRED' }, origin);
        validateSnapshot(body.snapshot);
        const clientTiming = validateClientTiming(body.clientTiming);
        try { await lark.validateDestination(body.destination); }
        catch (error) { return send(response, 422, { ok: false, code: 'INVALID_TARGET', message: error.message }, origin); }
        const submitted = await store.submit({
          attemptId: body.attemptId,
          sourceUrl: body.snapshot.sourceUrl,
          snapshot: body.snapshot,
          destination: body.destination,
          includeImages: body.includeImages !== false,
          clientTiming,
        });
        executor.kick();
        return send(response, submitted.created ? 202 : 200, { ok: true, created: submitted.created, job: jobView(submitted.job) }, origin);
      }

      const match = request.method === 'GET' && request.url?.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/i);
      if (match) {
        const job = await store.get(match[1]);
        return job ? send(response, 200, { ok: true, job: jobView(job) }, origin) : send(response, 404, { ok: false, code: 'JOB_NOT_FOUND' }, origin);
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
