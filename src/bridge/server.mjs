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
}

function jobView(job) {
  if (!job) return null;
  const { snapshot: _snapshot, ...visible } = job;
  return visible;
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
        if (!body.nodeToken) return send(response, 400, { ok: false, code: 'NODE_TOKEN_REQUIRED' }, origin);
        try {
          const destination = await lark.validateDestination(body);
          return send(response, 200, { ok: true, destination }, origin);
        } catch (error) {
          return send(response, 422, { ok: false, code: 'INVALID_TARGET', message: error.message }, origin);
        }
      }

      if (request.method === 'POST' && request.url === '/v1/jobs') {
        const body = await readJson(request);
        if (!body.attemptId || !body.destination?.nodeToken) return send(response, 400, { ok: false, code: 'JOB_INPUT_REQUIRED' }, origin);
        validateSnapshot(body.snapshot);
        try { await lark.validateDestination(body.destination); }
        catch (error) { return send(response, 422, { ok: false, code: 'INVALID_TARGET', message: error.message }, origin); }
        const submitted = await store.submit({
          attemptId: body.attemptId,
          sourceUrl: body.snapshot.sourceUrl,
          snapshot: body.snapshot,
          destination: body.destination,
          includeImages: body.includeImages !== false,
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
