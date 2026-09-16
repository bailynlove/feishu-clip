#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LarkClient } from './lark.mjs';
import { PairingStore } from './pairing.mjs';
import { IMAGE_MODES, JOB_KIND, JOB_STATUS, PDF_CHUNK_BYTES, PersistentJobStore, normalizePdfSource } from './job-store.mjs';
import { downloadPublicImage, downloadPublicPdf, PDF_LIMITS } from './image-policy.mjs';
import { PdfChunkStaging } from './pdf-chunks.mjs';
import { ClipExecutor, aiErrorMessage } from './executor.mjs';
import { AiConfigStore, DEFAULT_PROVIDER_NAME, generateDigest, mergeAiTestConfig, normalizeAiConfigInput, normalizeProviderName, sanitizeProvider } from './ai-digest.mjs';
import { BridgeSettingsStore } from './settings.mjs';

const JSON_LIMIT = 52 * 1024 * 1024;

// 与 normalizeAiConfigInput / normalizePdfSource 同一约定：TypeError + code，端点 catch 翻译成 400
function badRequest(code, message) {
  return Object.assign(new TypeError(message), { code });
}

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
// 提交时声明文件名/总大小/总块数/SHA-256（#61）。name/sizeBytes 对 url 型是可选展示信息。
// 校验实现与 job-store 共享（normalizePdfSource 是唯一一份，review 起不再双写）；
// 这里把 TypeError 按 code 翻译成 400，bytes 声明的大小上限与 url 型下载同一档（PDF_LIMITS.maxBytes）
function validatePdfSource(value) {
  try {
    return normalizePdfSource(value, { maxBytes: PDF_LIMITS.maxBytes });
  } catch (error) {
    if (error instanceof TypeError) {
      const code = error.code || 'PDF_SOURCE_INVALID';
      throw Object.assign(new Error(code), { status: 400, code });
    }
    throw error;
  }
}

async function submitPdfJobs({ store, attemptId, sourceUrl, sources, title = null, folderToken = null }) {
  const submitted = [];
  for (const source of sources) {
    const item = await store.submit({
      attemptId,
      sourceUrl: source.sourceUrl ?? sourceUrl ?? source.url,
      kind: JOB_KIND.PDF,
      pdfSource: source,
      title,
      folderToken,
      attachmentId: source.attachmentId ?? null,
    });
    submitted.push(item);
  }
  return submitted;
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

export async function createBridge({ config, lark = new LarkClient({ cliPath: config.larkCliPath }), logger = console, downloadPdf = downloadPublicPdf, downloadImage = downloadPublicImage, aiConfigStore, settingsStore }) {
  const pairing = new PairingStore(config.pairingFile);
  const store = new PersistentJobStore({ filePath: config.jobFile, jobTtlMs: config.jobTtlMs, awaitingBytesTtlMs: config.awaitingBytesTtlMs ?? 10 * 60 * 1_000 });
  // AI 摘要配置（#75）：ai.json store 可注入（测试可替）；bridge.json 缺 aiConfigFile 时
  // 端点按未配置处理（GET 返回 config:null，POST/test 400 AI_NOT_CONFIGURED）
  const aiStore = aiConfigStore ?? (config.aiConfigFile ? new AiConfigStore(config.aiConfigFile) : null);
  const bridgeSettings = settingsStore ?? (config.settingsFile ? new BridgeSettingsStore(config.settingsFile) : null);
  const withProxySettings = (download) => async (source, options = {}) => {
    const { proxyPort } = bridgeSettings ? await bridgeSettings.read() : { proxyPort: null };
    return download(source, { ...options, proxyPort });
  };
  // 分块暂存（#68）：staging 目录在 job 文件旁，executor 与分块端点共用同一实例
  const staging = new PdfChunkStaging({ dir: path.join(path.dirname(config.jobFile), 'staging') });
  const executor = new ClipExecutor({ store, lark, logger, staging, downloadPdf: withProxySettings(downloadPdf), downloadImage: withProxySettings(downloadImage), getAiConfig: aiStore ? (name) => (name ? aiStore.readProvider(name) : aiStore.readDefault()) : async () => null });
  // 摘要进度（#86）：executor 内存表合入 GET job 视图。只挂 clip job（进度由 clip 通道产生）；
  // 无进行中摘要（非 digest job / 已终态）不带 digestProgress 字段。
  // subdoc 模式（#98）阶段开始先落 {phase:'waiting',tokens:0} 条目（等共享 PDF 字节等的占位相位），
  // 调 AI 前翻 thinking；该条目同时是 popup 判别「subdoc 摘要进行中」的信号
  const jobViewWithProgress = (job) => {
    const view = jobView(job);
    if (!view || (job.kind ?? JOB_KIND.CLIP) !== JOB_KIND.CLIP) return view;
    const digestProgress = executor.digestProgressOf(job.attemptId);
    return digestProgress ? { ...view, digestProgress } : view;
  };
  // 过期恢复 + 建档歧义查证（reconcile）+ 消费队列：启动时跑一遍，之后周期 sweep，
  // reconciling 任务不再依赖 bridge 重启才能被捞起（#51）。unref 不拖进程退出。
  // sweep 是轻量本地操作，默认 60s 一次（#90，原 10min 间隔下死任务最长 10 分钟才被恢复，
  // 用户看到的是任务长时间无更新）；lease 60s 过期后最迟约 1 分钟内被 recoverExpired 发现
  // staging 清理（#68）：随 recoverExpired 的 expired 列表即时 discard，再按 mtime 扫超龄孤儿；
  // cancelled 的 pdf job（cancel 无 HTTP 端点、store 层不碰文件系统）也在这里即时 discard，
  // 不等超龄孤儿兜底
  const sweep = async () => {
    const recovered = await store.recoverExpired();
    for (const attemptId of recovered.expired) await staging.discard(attemptId).catch(() => {});
    for (const job of await store.list({ statuses: [JOB_STATUS.CANCELLED] })) await staging.discardForJob(job).catch(() => {});
    await staging.sweep(config.jobTtlMs ?? 24 * 60 * 60 * 1_000).catch((error) => logger.error('staging sweep failed', error));
    await executor.reconcile();
    executor.kick();
  };
  await sweep();
  const sweepTimer = setInterval(() => {
    sweep().catch((error) => logger.error('periodic sweep failed', error));
  }, config.sweepIntervalMs ?? 60_000);
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

      if (request.method === 'GET' && request.url === '/v1/settings/proxy') {
        const settings = bridgeSettings ? await bridgeSettings.read() : { proxyPort: null };
        return send(response, 200, { ok: true, proxyPort: settings.proxyPort }, origin);
      }

      if (request.method === 'POST' && request.url === '/v1/settings/proxy') {
        if (!bridgeSettings) return send(response, 400, { ok: false, code: 'SETTINGS_NOT_CONFIGURED', message: 'Bridge 未配置 settingsFile' }, origin);
        const body = await readJson(request);
        try {
          const settings = await bridgeSettings.saveProxyPort(body?.proxyPort);
          return send(response, 200, { ok: true, proxyPort: settings.proxyPort }, origin);
        } catch (error) {
          if (error instanceof TypeError) return send(response, 400, { ok: false, code: error.code || 'PROXY_PORT_INVALID', message: error.message }, origin);
          throw error;
        }
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

      // ——— AI provider 预设（#77）：ai.json 多套命名配置；key 只落 ai.json，任何端点不回显
      // （列表/保存后均返回 sanitizeProvider 结果）。「默认」受保护：可编辑，不可删除/改名 ———
      if (request.method === 'GET' && request.url === '/v1/ai/providers') {
        const providers = aiStore ? await aiStore.list() : [];
        return send(response, 200, { ok: true, providers: providers.map((p) => sanitizeProvider(p.name, p)) }, origin);
      }

      if (request.method === 'POST' && request.url === '/v1/ai/providers') {
        if (!aiStore) return send(response, 400, { ok: false, code: 'AI_NOT_CONFIGURED', message: 'Bridge 未配置 aiConfigFile' }, origin);
        const body = await readJson(request);
        try {
          const name = normalizeProviderName(body?.name);
          const renameFrom = body?.renameFrom === undefined ? undefined : normalizeProviderName(body.renameFrom);
          if (renameFrom !== undefined) {
            if (renameFrom === DEFAULT_PROVIDER_NAME) throw badRequest('AI_PROVIDER_PROTECTED', '「默认」provider 不可改名');
            if (name === renameFrom) throw badRequest('AI_RENAME_NOOP', '新旧名称相同');
            if (!(await aiStore.readProvider(renameFrom))) throw badRequest('AI_PROVIDER_NOT_FOUND', `provider「${renameFrom}」不存在`);
            if (await aiStore.readProvider(name)) throw badRequest('AI_PROVIDER_EXISTS', `provider「${name}」已存在`);
          }
          // 新建（目标名与改名来源都无已存 key）时 apiKey 必填；已有 key 时省略/空串 = 保留
          const keySource = (await aiStore.readProvider(name)) ?? (renameFrom ? await aiStore.readProvider(renameFrom) : null);
          const input = normalizeAiConfigInput(body, { requireKey: !keySource?.apiKey });
          const saved = await aiStore.saveProvider(name, input, { renameFrom });
          return send(response, 200, { ok: true, provider: sanitizeProvider(name, saved) }, origin);
        } catch (error) {
          return send(response, 400, { ok: false, code: error.code || 'AI_CONFIG_INVALID', message: error.message }, origin);
        }
      }

      if (request.method === 'POST' && request.url === '/v1/ai/providers/delete') {
        if (!aiStore) return send(response, 400, { ok: false, code: 'AI_NOT_CONFIGURED', message: 'Bridge 未配置 aiConfigFile' }, origin);
        const body = await readJson(request);
        try {
          const name = normalizeProviderName(body?.name);
          if (name === DEFAULT_PROVIDER_NAME) throw badRequest('AI_PROVIDER_PROTECTED', '「默认」provider 不可删除');
          if (!(await aiStore.deleteProvider(name))) throw badRequest('AI_PROVIDER_NOT_FOUND', `provider「${name}」不存在`);
          return send(response, 200, { ok: true }, origin);
        } catch (error) {
          return send(response, 400, { ok: false, code: error.code || 'AI_CONFIG_INVALID', message: error.message }, origin);
        }
      }

      // 测试连接：name 指定已存 provider（缺省 = 默认），请求体字段逐项覆盖；发一条最小真实请求验证连通性 + key + model
      if (request.method === 'POST' && request.url === '/v1/ai/test') {
        if (!aiStore) return send(response, 400, { ok: false, code: 'AI_NOT_CONFIGURED', message: 'Bridge 未配置 aiConfigFile' }, origin);
        const body = await readJson(request);
        let merged;
        try {
          const saved = body?.name
            ? await aiStore.readProvider(normalizeProviderName(body.name))
            : await aiStore.readDefault();
          if (body?.name && !saved) throw badRequest('AI_PROVIDER_NOT_FOUND', `provider「${normalizeProviderName(body.name)}」不存在`);
          merged = mergeAiTestConfig(body ?? {}, saved);
        } catch (error) {
          return send(response, 400, { ok: false, code: error.code || 'AI_NOT_CONFIGURED', message: error.message }, origin);
        }
        try {
          const startedAt = Date.now();
          // 不传显式 maxOutputTokens：走 merged.maxOutputTokens ?? 内置默认（2048）。
          // 硬编码小预算会让 reasoning 模型在推理阶段耗尽 output tokens（incomplete/max_output_tokens）。
          // stream:false（#86）：测试连接保持非流式——探针要的是最小真实请求，不需要进度
          const reply = await generateDigest({ config: merged, instruction: 'You are a connectivity probe.', content: 'Reply with: ok', stream: false });
          return send(response, 200, { ok: true, latencyMs: Date.now() - startedAt, reply: reply.slice(0, 100) }, origin);
        } catch (error) {
          return send(response, 200, { ok: false, code: error.code || 'AI_REQUEST_FAILED', message: aiErrorMessage(error) }, origin);
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

      // Drive 目录选择器端点族（#66）：省略 parentFolderToken 即根层「我的空间」；
      // 返回全部子项——文件夹可下钻/选中，文件项由 picker 置灰展示（不可选不可下钻）
      if (request.method === 'GET' && request.url?.startsWith('/v1/drive/folders')) {
        const { pathname, cursor, limit, query } = parseTargetQuery(request, ['parentFolderToken', 'cursor', 'limit']);
        if (pathname !== '/v1/drive/folders') return send(response, 404, { ok: false, code: 'NOT_FOUND' }, origin);
        const parentFolderToken = query.get('parentFolderToken');
        if (parentFolderToken !== null && !WIKI_TOKEN.test(parentFolderToken)) return send(response, 400, { ok: false, code: 'TARGET_QUERY_INVALID', message: 'parentFolderToken 不合法' }, origin);
        try {
          const result = await lark.listDriveItems({ folderToken: parentFolderToken || undefined, pageToken: cursor, pageSize: limit });
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
          ...jobViewWithProgress(job),
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
          const pdfSources = Array.isArray(body.pdfSources) ? body.pdfSources : [body.pdfSource];
          const validSources = pdfSources.filter(Boolean).map(validatePdfSource);
          if (validSources.length === 0) return send(response, 400, { ok: false, code: 'PDF_SOURCE_REQUIRED' }, origin);
          const pdfSource = validSources[0];
          const pdfFolderToken = body.pdfFolderToken === undefined || body.pdfFolderToken === null ? null : body.pdfFolderToken;
          if (pdfFolderToken !== null && (typeof pdfFolderToken !== 'string' || !WIKI_TOKEN.test(pdfFolderToken))) {
            return send(response, 400, { ok: false, code: 'PDF_FOLDER_INVALID', message: 'pdfFolderToken 不合法' }, origin);
          }
          // sourceUrl 取 PDF 地址本身：弹窗按它做同页 job 恢复（isJobForPage）。
          // 例外（#99 续）：clip 流创建的 pdf job sourceUrl 是页面 URL——declare 升级
          // （凭据回传补交 bytes 声明）必须沿用既有绑定，否则被 job-store 的
          // attemptId↔sourceUrl 绑定校验误拒（MDPI 实测三次 declare 全部被打回）
          const existingJobs = await store.get(body.attemptId).catch(() => []);
          const existingPdfJobs = existingJobs.filter((job) => job.kind === JOB_KIND.PDF);
          const sources = validSources.map((source, index) => {
            const requestedId = pdfSources[index]?.attachmentId;
            const existing = existingPdfJobs.find((job) => requestedId != null
              ? job.attachmentId === requestedId
              : job.pdfSource?.url === source.url);
            return {
              ...source,
              attachmentId: requestedId ?? existing?.attachmentId ?? (index ? `pdf-${index + 1}` : null),
              sourceUrl: existing?.sourceUrl ?? source.url,
            };
          });
          const submittedList = await submitPdfJobs({ store, attemptId: body.attemptId, sources, title: typeof body.title === 'string' && body.title ? body.title : null, folderToken: pdfFolderToken });
          const submitted = submittedList[0];
          const pdfJobs = submittedList.map((item) => item.job);
          executor.kick();
          return send(response, submitted.created ? 202 : 200, { ok: true, created: submitted.created, job: null, pdfJob: jobView(submitted.job), pdfJobs: pdfJobs.map(jobView) }, origin);
        }
        const isSpaceTarget = body.destination?.kind === 'space';
        if (!body.attemptId || !(isSpaceTarget ? body.destination?.spaceId : body.destination?.nodeToken)) return send(response, 400, { ok: false, code: 'JOB_INPUT_REQUIRED' }, origin);
        validateSnapshot(body.snapshot);
        const clientTiming = validateClientTiming(body.clientTiming);
        const rawPdfSources = Array.isArray(body.pdfSources) ? body.pdfSources : (body.pdfSource == null ? [] : [body.pdfSource]);
        const normalizedPdfSources = rawPdfSources.map((source) => ({ ...validatePdfSource(source), attachmentId: source.attachmentId ?? null }));
        const declaredNoPrimary = Object.hasOwn(body, 'primaryAttachmentId') && body.primaryAttachmentId === null;
        const pdfSource = normalizedPdfSources.find((source, index) => rawPdfSources[index]?.primary === true)
          ?? (declaredNoPrimary ? null : normalizedPdfSources[0] ?? null);
        const primaryAttachmentId = declaredNoPrimary ? null : (body.primaryAttachmentId ?? pdfSource?.attachmentId ?? null);
        if (body.pdfFailurePolicy !== undefined && body.pdfFailurePolicy !== 'continue' && body.pdfFailurePolicy !== 'abort') {
          return send(response, 400, { ok: false, code: 'PDF_FAILURE_POLICY_INVALID', message: 'pdfFailurePolicy 只接受 continue / abort' }, origin);
        }
        const pdfFailurePolicy = body.pdfFailurePolicy === 'abort' ? 'abort' : 'continue';
        // pdf 目标目录（#66）：null = 云盘根目录；非空须是合法 token 形态
        const pdfFolderToken = body.pdfFolderToken === undefined || body.pdfFolderToken === null ? null : body.pdfFolderToken;
        if (pdfFolderToken !== null && (typeof pdfFolderToken !== 'string' || !WIKI_TOKEN.test(pdfFolderToken))) {
          return send(response, 400, { ok: false, code: 'PDF_FOLDER_INVALID', message: 'pdfFolderToken 不合法' }, origin);
        }
        try { await lark.validateDestination(body.destination); }
        catch (error) { return send(response, 422, { ok: false, code: 'INVALID_TARGET', message: error.message }, origin); }
        // 图片写入模式（#53）：合法三态直用；非法/缺省回退旧 includeImages 布尔语义（false → off，其余 → preview）
        const imageMode = IMAGE_MODES.includes(body.imageMode) ? body.imageMode : (body.includeImages === false ? 'off' : 'preview');
        // AI 摘要（#75）：digest.enabled===true 时要求非空 instruction（长度不设限——长系统指令
        // 是合法用法，截断曾切掉尾部 {{@file}} 导致 AI 收不到 PDF）；pdf-only 路径忽略。
        // provider（#78）：选填，非空字符串 ≤64（与 provider 命名上限一致）；缺省 = 默认 provider
        let digest = null;
        if (body.digest?.enabled === true) {
          const instruction = body.digest.instruction;
          if (typeof instruction !== 'string' || !instruction.trim()) {
            return send(response, 400, { ok: false, code: 'DIGEST_INVALID', message: '开启 AI 摘要时必须提供非空摘要指令' }, origin);
          }
          digest = { enabled: true, instruction };
          const provider = body.digest.provider;
          if (provider !== undefined) {
            if (typeof provider !== 'string' || !provider.trim() || provider.length > 64) {
              return send(response, 400, { ok: false, code: 'DIGEST_INVALID', message: 'digest.provider 必须是非空字符串（≤64 字符）' }, origin);
            }
            digest.provider = provider.trim();
          }
          // mode（#98）：inline 内联 / subdoc 子文档，缺省 subdoc，其他值拒绝
          if (body.digest.mode !== undefined && body.digest.mode !== 'inline' && body.digest.mode !== 'subdoc') {
            return send(response, 400, { ok: false, code: 'DIGEST_INVALID', message: 'digest.mode 只接受 inline / subdoc' }, origin);
          }
          digest.mode = body.digest.mode ?? 'subdoc';
          // 子文档标题（#98）：extension 已渲染模板；去空白、截 180 字符，空白/缺省回落 Digest
          const docTitle = typeof body.digest.docTitle === 'string' ? body.digest.docTitle.trim().slice(0, 180) : '';
          digest.docTitle = docTitle || 'Digest';
        }
        const submitted = await store.submit({
          attemptId: body.attemptId,
          sourceUrl: body.snapshot.sourceUrl,
          snapshot: body.snapshot,
          destination: body.destination,
          includeImages: imageMode !== 'off',
          imageMode,
          clientTiming,
          digest,
          // {{@file}} 附件（#79）：clip job 同携 pdfSource，digest 阶段检出占位符时据此下载
          pdfSource,
          primaryAttachmentId,
          pdfFailurePolicy,
        });
        // 双 job（#60/#65）：同一 attemptId 附带 pdf job，title 用渲染后的快照标题做云盘文件命名；
        // folderToken（#66）是 picker/弹窗选定的云盘目录，null 即根目录
        let pdfSubmitted = null;
        const pdfSubmittedList = [];
        if (normalizedPdfSources.length) {
          pdfSubmittedList.push(...await submitPdfJobs({ store, attemptId: body.attemptId, sourceUrl: body.snapshot.sourceUrl, sources: normalizedPdfSources, title: body.snapshot.title, folderToken: pdfFolderToken }));
          pdfSubmitted = pdfSubmittedList[0];
        }
        executor.kick();
        return send(response, submitted.created ? 202 : 200, { ok: true, created: submitted.created, job: jobView(submitted.job), pdfJob: pdfSubmitted ? jobView(pdfSubmitted.job) : null, pdfJobs: pdfSubmittedList.map((item) => jobView(item.job)) }, origin);
      }

      // ——— 分块通道（#61/#68）：扩展凭据回传 PDF 字节 ———
      // 动态 PDF 的源站响应可能逐次变化。扩展缓存缺失后会重新抓取；若尚未收到任何块，
      // 允许它用同 URL 的新大小/hash 原子替换旧声明，再从第 0 块开始上传。
      const declarationUrl = new URL(request.url, 'http://127.0.0.1');
      const declarationMatch = declarationUrl.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/pdf-declaration$/i);
      const declarationAttachmentId = declarationUrl.searchParams.get('attachmentId') || null;
      if (declarationMatch && request.method === 'PUT') {
        const job = await store.get(declarationMatch[1], JOB_KIND.PDF, declarationAttachmentId);
        if (!job) return send(response, 404, { ok: false, code: 'JOB_NOT_FOUND' }, origin);
        if (job.status !== JOB_STATUS.AWAITING_BYTES || job.pdfSource?.type !== 'bytes') {
          return send(response, 409, { ok: false, code: 'PDF_BYTES_NOT_EXPECTED' }, origin);
        }
        if ((await staging.bitmap(job.attemptId, job.attachmentId)).length) {
          return send(response, 409, { ok: false, code: 'PDF_DECLARATION_LOCKED' }, origin);
        }
        const body = await readJson(request);
        const pdfSource = validatePdfSource(body?.pdfSource);
        if (pdfSource.type !== 'bytes') return send(response, 400, { ok: false, code: 'PDF_SOURCE_INVALID' }, origin);
        const replaced = await store.replaceBytesDeclaration(job.attemptId, pdfSource, job.attachmentId);
        return send(response, 200, { ok: true, pdfJob: jobView(replaced) }, origin);
      }

      // GET 返回已收块位图（续传断点）；POST 写一块（4 MiB 原字节 base64 + index）。
      // 全部到齐 + 整文件 SHA-256 验证通过 → job 转 queued（executor 走 staging 上传）；
      // hash 不匹配 → 422 + job failed + 清理 staging。端点只服务 awaiting_bytes 的 pdf job
      const chunkUrl = new URL(request.url, 'http://127.0.0.1');
      const chunksMatch = chunkUrl.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/pdf-chunks$/i);
      const chunkAttachmentId = chunkUrl.searchParams.get('attachmentId') || null;
      if (chunksMatch && request.method === 'GET') {
        const job = await store.get(chunksMatch[1], JOB_KIND.PDF, chunkAttachmentId);
        if (!job) return send(response, 404, { ok: false, code: 'JOB_NOT_FOUND' }, origin);
        if (job.status !== JOB_STATUS.AWAITING_BYTES) return send(response, 409, { ok: false, code: 'PDF_BYTES_NOT_EXPECTED' }, origin);
        // declared=false 表示 url 型回退尚未补交 bytes 声明（扩展先做声明再喂块）
        const declared = job.pdfSource?.type === 'bytes' ? job.pdfSource : null;
        return send(response, 200, {
          ok: true,
          declared: Boolean(declared),
          totalChunks: declared?.totalChunks ?? null,
          sizeBytes: declared?.sizeBytes ?? null,
          bitmap: await staging.bitmap(job.attemptId, job.attachmentId),
        }, origin);
      }
      if (chunksMatch && request.method === 'POST') {
        const job = await store.get(chunksMatch[1], JOB_KIND.PDF, chunkAttachmentId);
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
        const bitmap = await staging.putChunk(job.attemptId, job.attachmentId, body.index, buffer);
        if (bitmap.length < declared.totalChunks) {
          return send(response, 200, { ok: true, complete: false, received: bitmap.length, totalChunks: declared.totalChunks, bitmap }, origin);
        }
        try {
          await staging.verify(job.attemptId, job.attachmentId, declared);
        } catch {
          // 整验失败：拒收——job failed、staging 清理，不产生云盘文件
          await staging.discard(job.attemptId, job.attachmentId);
          await store.failBytes(job.attemptId, 'PDF 字节校验失败（SHA-256 不匹配），已拒绝接收', job.attachmentId);
          return send(response, 422, { ok: false, code: 'PDF_HASH_MISMATCH' }, origin);
        }
        await store.markBytesReady(job.attemptId, job.attachmentId);
        executor.kick();
        return send(response, 200, { ok: true, complete: true, received: bitmap.length, totalChunks: declared.totalChunks }, origin);
      }

      const match = request.method === 'GET' && request.url?.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/i);
      if (match) {
        // get(attemptId) 语义升为「一次尝试」（#60）：返回该 attempt 的全部 job，弹窗侧做聚合呈现
        const jobs = await store.get(match[1]);
        return jobs.length
          ? send(response, 200, { ok: true, jobs: jobs.map(jobViewWithProgress) }, origin)
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
