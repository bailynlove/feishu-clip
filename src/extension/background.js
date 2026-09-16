import { DEFAULT_DIGEST_DOC_TITLE, ensurePresets, resolveDigestInstruction } from './presets.js';
import { buildContext, renderBody, renderTemplate, sanitizeClipTitle } from './templates.js';
import { isJobForPage } from './popup-state.js';
import { createIncrementalSha256 } from './sha256.js';
import { detectBuiltInPdf } from './pdf-translators-builtins.js';
import { normalizePdfCandidates } from './pdf-attachments.js';
import { effectivePdfTranslatorRegistry, PDF_TRANSLATORS_STORAGE_KEY, PDF_TRANSLATOR_DISABLED_BUILTINS_KEY } from './pdf-translator-store.js';

const BRIDGE = 'http://127.0.0.1:38479';
// 分块切块口径与 src/bridge/job-store.mjs 的 PDF_CHUNK_BYTES 保持一致（SW 与 bridge 分属
// 两个运行时，无法共享模块，修改须两边同步）
const PDF_CHUNK_BYTES = 4 * 1024 * 1024;

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

// service worker 冷启动时幂等迁移预设存储；in-flight 复用防止并发调用各自生成 UUID 的竞态
let migrating = null;
function migratePresets() {
  migrating ??= ensurePresets(chrome.storage.local).finally(() => { migrating = null; });
  return migrating;
}
migratePresets();

async function localGet(keys) {
  return chrome.storage.local.get(keys);
}

async function bridge(path, { method = 'GET', body, authenticated = true } = {}) {
  const stored = await localGet(['credential']);
  const headers = { 'X-Feishu-Clip-Origin': `chrome-extension://${chrome.runtime.id}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authenticated && stored.credential) headers.Authorization = `Bearer ${stored.credential}`;
  let response;
  try {
    response = await fetch(`${BRIDGE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('本地 Bridge 未运行'), { code: 'BRIDGE_OFFLINE' });
  }
  const result = await response.json().catch(() => ({ ok: false, code: `HTTP_${response.status}` }));
  if (!response.ok) throw Object.assign(new Error(result.message || result.code || `HTTP_${response.status}`), result);
  return result;
}

async function extractActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw Object.assign(new Error('当前页面不支持剪藏'), { code: 'UNSUPPORTED_PAGE' });
  const [execution] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extractor.js'] });
  if (!execution?.result) throw new Error('未能读取当前页面');
  if (execution.result.error) throw new Error(execution.result.error);
  const result = execution.result;
  if (supportsPdfTranslatorHost()) {
    const translated = await runPdfTranslators(tab).catch(() => null);
    if (translated?.attachments?.length) {
      result.pdfAttachments = translated.attachments;
      result.pdf = translated.attachments.find((item) => item.primary) ?? translated.attachments[0];
      result.pdfTranslatorDiagnostics = translated.diagnostics;
    }
  } else {
    // Test/legacy browser fallback while offscreen documents are unavailable.
    const builtin = detectBuiltInPdf(result.sourceUrl, null);
    if (builtin) result.pdf = { ...builtin, sizeBytes: result.pdf?.sizeBytes ?? null };
  }
  return result;
}

function supportsPdfTranslatorHost() {
  return Boolean(chrome.offscreen?.createDocument && chrome.runtime?.sendMessage && chrome.runtime?.getURL);
}

function pageSnapshot() {
  const html = document.documentElement?.outerHTML || '';
  return { url: location.href, html: html.length > 5 * 1024 * 1024 ? html.slice(0, 5 * 1024 * 1024) : html };
}

let translatorHostCreating = null;
async function ensurePdfTranslatorHost() {
  if (await chrome.offscreen.hasDocument?.()) return;
  translatorHostCreating ??= chrome.offscreen.createDocument({
    url: 'translator-host.html',
    reasons: ['DOM_SCRAPING'],
    justification: 'Run user-installed PDF translators inside a scripts-only sandbox iframe',
  }).finally(() => { translatorHostCreating = null; });
  await translatorHostCreating;
}

async function runPdfTranslators(tab) {
  const stored = await localGet([PDF_TRANSLATORS_STORAGE_KEY, PDF_TRANSLATOR_DISABLED_BUILTINS_KEY]);
  const registry = effectivePdfTranslatorRegistry(stored[PDF_TRANSLATORS_STORAGE_KEY], stored[PDF_TRANSLATOR_DISABLED_BUILTINS_KEY]);
  if (!registry.active.length) return { attachments: [], diagnostics: [] };
  const [execution] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageSnapshot });
  if (!execution?.result) return { attachments: [], diagnostics: [] };
  await ensurePdfTranslatorHost();
  const response = await chrome.runtime.sendMessage({ target: 'pdf-translator-host', type: 'RUN_PDF_TRANSLATORS', translators: registry.active, page: execution.result });
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message || 'PDF Translator 执行失败'), response?.error);
  return response.result;
}

// ——— PDF 标签页识别（#67，调研结论见 #58/research/pdf-tab-detection）———
// 主判定：注入探针读 document.contentType（Zotero 同款信号，activeTab+scripting 零权限增量），
// 与 extractActiveTab 的 UNSUPPORTED_PAGE 判定相互独立——PDF 标签页不是"不支持的页面"，是另一种形态。
// 注入失败（file:// 未授权、特殊页面等）才回退 tab.url 的 .pdf 后缀启发式（忽略 query/hash）。

// 后缀兜底只作"疑似 PDF"判定：探针成功时以 contentType 为准（.pdf URL 返回 HTML 登录墙不算）
function isPdfUrl(pageUrl) {
  try { return /\.pdf$/i.test(new URL(pageUrl).pathname); } catch { return false; }
}

function pdfNameFromUrl(pageUrl) {
  try {
    const last = new URL(pageUrl).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch { return null; }
}

// 注入失败时的兜底校验（review #67）：.pdf 后缀只是启发式——登录墙/错误页也常以 .pdf 结尾。
// SW 持凭据发 HEAD 核对 content-type；网络失败或不符（HTML 登录墙等）一律保守不判，不进 PDF 面板
async function headConfirmsPdf(pageUrl) {
  try {
    const response = await fetch(pageUrl, { method: 'HEAD', credentials: 'include' });
    return String(response.headers.get('content-type') || '').toLowerCase().includes('application/pdf');
  } catch {
    return false;
  }
}

// 探针在页面上下文执行（executeScript 序列化 func，须自包含）：命中 PDF 时顺带用 HEAD
// 拿文件大小（拿不到不阻塞识别，弹窗显示「未知大小」），title 在内嵌查看器里即文件名
function pdfTabProbe() {
  if (document.contentType !== 'application/pdf') return { contentType: document.contentType };
  return fetch(location.href, { method: 'HEAD', credentials: 'same-origin' })
    .then((response) => {
      const length = Number(response.headers.get('content-length'));
      const sizeBytes = response.ok && Number.isFinite(length) && length > 0 ? length : null;
      return { contentType: document.contentType, title: document.title, sizeBytes };
    })
    .catch(() => ({ contentType: document.contentType, title: document.title, sizeBytes: null }));
}

async function detectPdfTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return { pdfTab: null };
  try {
    const [execution] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pdfTabProbe });
    if (execution?.result?.contentType !== 'application/pdf') return { pdfTab: null };
    return { pdfTab: { url: tab.url, name: execution.result.title || pdfNameFromUrl(tab.url), sizeBytes: execution.result.sizeBytes ?? null } };
  } catch {
    if (!isPdfUrl(tab.url)) return { pdfTab: null };
    if (!(await headConfirmsPdf(tab.url))) return { pdfTab: null };
    return { pdfTab: { url: tab.url, name: pdfNameFromUrl(tab.url), sizeBytes: null } };
  }
}

// ——— 凭据回传（#68）：pdf job 进 awaiting_bytes 后，SW 持凭据抓源站、流式切块回传 ———
// 声明必须先于分块（#61），而 SHA-256 要读完流才能算出，所以回退路径是两遍流：
// 第一遍只算哈希与总大小（不落盘、内存恒定），声明落库后第二遍切块 POST；
// 中断（SW 被杀）重连先查位图只补缺块——声明已在库时连第一遍都省掉
const pdfFeedInFlight = new Map(); // attemptId → Promise（SW 内 in-flight 去重）

// Uint8Array → base64：分片转 binary string，避免 4 MiB 整块 spread 爆参数栈
function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function openPdfStream(pdfUrl) {
  let response;
  try {
    response = await fetch(pdfUrl, { credentials: 'include' });
  } catch (error) {
    // 跨域被 CORS 拦截/断网等都在此落地（manifest 已带全站 host 权限，CORS 不应再发生）
    throw Object.assign(new Error(`源站请求失败：${error.message}`), { code: 'PDF_SOURCE_FETCH_FAILED' });
  }
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error('源站仍要求登录，请先在源站登录后重试'), { code: 'PDF_SOURCE_AUTH' });
  }
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`源站返回 HTTP ${response.status}，无法读取 PDF`), { code: 'PDF_SOURCE_FETCH_FAILED' });
  }
  return response.body.getReader();
}

// 流式过一遍源站：累计大小 + 增量 SHA-256；onChunk 用于第二遍的切块回调
async function readPdfPass(pdfUrl, onChunk = null) {
  const reader = await openPdfStream(pdfUrl);
  const hash = createIncrementalSha256();
  let sizeBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sizeBytes += value.byteLength;
    hash.update(value);
    if (onChunk) await onChunk(value);
  }
  return { sizeBytes, sha256: hash.hex() };
}

async function feedPdfBytes({ attemptId, pdfUrl, name = null }) {
  if (!attemptId || !/^https?:/.test(pdfUrl || '')) {
    throw Object.assign(new Error('PDF 回传参数不完整'), { code: 'PDF_FEED_INVALID' });
  }
  if (pdfFeedInFlight.has(attemptId)) return pdfFeedInFlight.get(attemptId);
  const task = doFeedPdfBytes({ attemptId, pdfUrl, name }).finally(() => pdfFeedInFlight.delete(attemptId));
  pdfFeedInFlight.set(attemptId, task);
  return task;
}

async function doFeedPdfBytes({ attemptId, pdfUrl, name }) {
  const { jobs } = await bridge(`/v1/jobs/${attemptId}`);
  const job = (jobs ?? []).find((candidate) => candidate.kind === 'pdf');
  if (!job || job.status !== 'awaiting_bytes') return { fed: false, status: job?.status ?? 'missing' };
  let declared = job.pdfSource?.type === 'bytes' ? job.pdfSource : null;
  if (!declared) {
    // 第一遍流式读：只算 SHA-256 与总大小（bytes 声明必须先于分块，#61）
    const measured = await readPdfPass(pdfUrl);
    if (measured.sizeBytes < 1) throw Object.assign(new Error('源站返回空内容'), { code: 'PDF_SOURCE_FETCH_FAILED' });
    declared = {
      type: 'bytes',
      url: job.pdfSource?.url ?? pdfUrl,
      name: name ?? job.pdfSource?.name ?? job.title ?? 'clip.pdf',
      sizeBytes: measured.sizeBytes,
      totalChunks: Math.ceil(measured.sizeBytes / PDF_CHUNK_BYTES),
      sha256: measured.sha256,
    };
    await bridge('/v1/jobs', { method: 'POST', body: { attemptId, pdfSource: declared } });
  }
  const { bitmap } = await bridge(`/v1/jobs/${attemptId}/pdf-chunks`);
  const received = new Set(bitmap ?? []);
  // 第二遍流式读：按 4 MiB 切块，只补位图缺失的块（bridge 侧重发幂等，断点续传）
  let index = 0;
  let pending = new Uint8Array(0);
  let uploaded = 0;
  const flush = async (final = false) => {
    while (pending.byteLength >= PDF_CHUNK_BYTES || (final && pending.byteLength > 0)) {
      const chunk = pending.slice(0, Math.min(PDF_CHUNK_BYTES, pending.byteLength));
      pending = pending.slice(chunk.byteLength);
      if (!received.has(index)) {
        await bridge(`/v1/jobs/${attemptId}/pdf-chunks`, {
          method: 'POST',
          body: { index, totalChunks: declared.totalChunks, dataBase64: toBase64(chunk) },
        });
        uploaded += 1;
      }
      index += 1;
    }
  };
  await readPdfPass(pdfUrl, async (value) => {
    const merged = new Uint8Array(pending.byteLength + value.byteLength);
    merged.set(pending);
    merged.set(value, pending.byteLength);
    pending = merged;
    await flush();
  });
  await flush(true);
  return { fed: true, uploaded, totalChunks: declared.totalChunks };
}

async function handle(message) {
  switch (message.type) {
    case 'PAIR': {
      const result = await bridge('/v1/pair', { method: 'POST', body: { code: message.code }, authenticated: false });
      await chrome.storage.local.set({ credential: result.credential });
      return result;
    }
    case 'STATUS': return bridge('/v1/status');
    case 'GET_SETTINGS': {
      await migratePresets();
      // activeAttempt 供 job 恢复；presets/defaultPresetId 供弹窗与设置页（#35/#36）；
      // developerMode 供设置页开发者模式开关（缺省 false）；
      // aiDigestInstruction 供设置页 AI 摘要区与 CLIP 指令回落（#75，非敏感）；
      // optionsUiCollapsed 供设置页分区折叠状态回填（#76）
      return localGet(['activeAttempt', 'presets', 'defaultPresetId', 'developerMode', 'aiDigestInstruction', 'optionsUiCollapsed']);
    }
    case 'GET_PROXY_SETTINGS': return bridge('/v1/settings/proxy');
    case 'SAVE_PROXY_SETTINGS': return bridge('/v1/settings/proxy', { method: 'POST', body: { proxyPort: message.proxyPort } });
    // AI provider 预设（#77）：四个端点纯代理到 bridge；API key 只存 bridge 的 ai.json，
    // 扩展侧任何环节不落地（SAVE 留空的 apiKey 由 options.js 组装请求体时省略）
    case 'LIST_AI_PROVIDERS': return bridge('/v1/ai/providers');
    case 'SAVE_AI_PROVIDER': return bridge('/v1/ai/providers', { method: 'POST', body: message.provider });
    case 'DELETE_AI_PROVIDER': return bridge('/v1/ai/providers/delete', { method: 'POST', body: { name: message.name } });
    case 'TEST_AI': return bridge('/v1/ai/test', { method: 'POST', body: { ...(message.name ? { name: message.name } : {}), ...(message.overrides ?? {}) } });
    case 'SAVE_PRESETS': {
      // 设置页整体写回预设列表 + 默认预设（#35）；列表为空或默认预设悬空时拒绝/修复
      if (!Array.isArray(message.presets) || message.presets.length === 0) throw new Error('至少保留一套预设');
      const defaultPresetId = message.presets.some((preset) => preset.id === message.defaultPresetId)
        ? message.defaultPresetId
        : message.presets[0].id;
      await chrome.storage.local.set({ presets: message.presets, defaultPresetId });
      return { presets: message.presets, defaultPresetId };
    }
    case 'VALIDATE_DESTINATION': return bridge('/v1/destinations/validate', { method: 'POST', body: message.destination });
    case 'LIST_SPACES': {
      const params = new URLSearchParams();
      if (message.cursor) params.set('cursor', message.cursor);
      if (message.limit) params.set('limit', String(message.limit));
      const query = params.toString();
      return bridge(`/v1/targets/spaces${query ? `?${query}` : ''}`);
    }
    case 'LIST_NODES': {
      const params = new URLSearchParams({ spaceId: message.spaceId });
      if (message.parentNodeToken) params.set('parentNodeToken', message.parentNodeToken);
      if (message.cursor) params.set('cursor', message.cursor);
      if (message.limit) params.set('limit', String(message.limit));
      return bridge(`/v1/targets/nodes?${params}`);
    }
    // Drive 目录选择器（#66）：省略 folderToken 列根层「我的空间」
    case 'LIST_DRIVE_FOLDERS': {
      const params = new URLSearchParams();
      if (message.folderToken) params.set('parentFolderToken', message.folderToken);
      if (message.cursor) params.set('cursor', message.cursor);
      if (message.limit) params.set('limit', String(message.limit));
      const query = params.toString();
      return bridge(`/v1/drive/folders${query ? `?${query}` : ''}`);
    }
    case 'VALIDATE_DRIVE_FOLDER': return bridge('/v1/drive/folders/validate', { method: 'POST', body: { folderToken: message.folderToken ?? null } });
    case 'CLIP': {
      // 开发者模式耗时诊断：页面提取在扩展侧完成，bridge 看不到这段，故由扩展计时后随 job 上报考勤
      const extractStart = performance.now();
      const snapshot = await extractActiveTab();
      const extractMs = Math.round(performance.now() - extractStart);
      // 弹窗可编辑标题（#36）：渲染/手改结果随 CLIP 发来，清洗后覆盖；为空回退 extractor 标题
      const title = sanitizeClipTitle(message.title);
      if (title) snapshot.title = title;
      // AI 摘要（#75）：开关开启时让 {{digest}} 以字面量穿过正文渲染（最终替换在 bridge 侧），
      // 并在 CLIP 路径解析指令兜底（预设级 > 全局 > 内置默认）——弹窗只透传预设级原值，
      // 在这里解析可防陈旧弹窗发来空指令；instruction 长度不设限（长系统指令是合法用法，
      // 此前的 4000 字截断曾切掉尾部 {{@file}} 占位符导致 AI 收不到 PDF）
      const digestEnabled = message.digestEnabled === true;
      let digest = null;
      if (digestEnabled) {
        const stored = await localGet(['aiDigestInstruction']);
        digest = { enabled: true, instruction: resolveDigestInstruction(message.digestInstruction, stored.aiDigestInstruction) };
        // provider（#78）：预设选用的 provider 名；空白/缺省不带键（bridge = 默认 provider），
        // 上限 64 字符与 bridge 校验口径一致，超长截断
        const provider = typeof message.digestProvider === 'string' ? message.digestProvider.trim().slice(0, 64) : '';
        if (provider) digest.provider = provider;
        // mode（#98）：inline 内联 / subdoc 子文档，非法值归一 subdoc（与 resolveDigest 同口径）
        digest.mode = message.digestMode === 'inline' ? 'inline' : 'subdoc';
        // 子文档标题（#98）：用标题覆盖后的快照上下文渲染模板，空白回落默认标题；
        // inline 模式也照常计算透传（bridge 只在 subdoc 用），保持载荷口径单一
        const template = typeof message.digestDocTitleTemplate === 'string' ? message.digestDocTitleTemplate : '';
        digest.docTitle = renderTemplate(template, buildContext(snapshot)).trim() || DEFAULT_DIGEST_DOC_TITLE;
      }
      // 正文合成（#37，#40 起有效模板 = 弹窗自定义正文框内容）：与弹窗预览同调 renderBody；
      // ctx 在标题覆盖之后构建，正文模板看到的即最终标题
      snapshot.markdown = renderBody(message.customBody, buildContext(snapshot, { digestEnabled }));
      // 重试 PDF（#65）：弹窗「重试 PDF」复用同一 attemptId，bridge 侧 clip job 幂等命中、
      // pdf job 失败态复位重跑；正常保存总是新 attemptId
      const attemptId = message.attemptId ?? crypto.randomUUID();
      // pdfSource 以保存时快照的识别结果为准（比弹窗打开时的探测更新），探测结果兜底
      const detected = message.pdfEnabled === true ? (snapshot.pdf ?? message.pdfSource ?? null) : null;
      const normalizedPdfs = message.pdfEnabled === true
        ? normalizePdfCandidates(snapshot.pdfAttachments ?? (detected ? [detected] : [])).attachments
        : [];
      const pdfSources = normalizedPdfs.map((item) => ({ type: 'url', url: item.url, name: item.name, sizeBytes: item.sizeBytes, attachmentId: item.id, primary: item.primary }));
      const primarySource = pdfSources.find((item) => item.primary) ?? pdfSources[0] ?? null;
      const { primary: _primary, attachmentId: _attachmentId, ...pdfSource } = primarySource || {};
      // pdf 目标目录（#66）：弹窗 chip 选定的 folderToken（null = 云盘根目录），随 job 透传
      const pdfFolderToken = typeof message.pdfFolderToken === 'string' && message.pdfFolderToken ? message.pdfFolderToken : null;
      const result = await bridge('/v1/jobs', { method: 'POST', body: { attemptId, snapshot: { ...snapshot, pdfAttachments: normalizedPdfs }, destination: message.destination, includeImages: message.includeImages, imageMode: message.imageMode, clientTiming: { extractMs }, pdfSource: primarySource ? pdfSource : null, pdfSources, pdfFolderToken, digest } });
      await chrome.storage.local.set({ activeAttempt: attemptId });
      return result;
    }
    // PDF 标签页判定（#67）：弹窗打开时先于一切剪藏逻辑调用；命中即整体切换为 pdf-tab 单面板
    case 'DETECT_PDF_TAB': return detectPdfTab();
    // PDF 标签页保存（#67）：只提交 kind:'pdf' 的 job——不走 extractor、不建剪藏文档；
    // 字节默认走 bridge 按 URL 下载（url 型 pdfSource），撞 401/403 由 bridge 转
    // awaiting_bytes，弹窗轮询看到后走 #68 的凭据分块回传。
    // attemptId 复用支持失败后重试（bridge 对 failed pdf job 幂等复位重排）
    case 'SAVE_PDF_TAB': {
      const source = message.pdfSource;
      if (!source?.url || !/^https?:/.test(source.url)) throw Object.assign(new Error('PDF 地址不可用'), { code: 'PDF_SOURCE_REQUIRED' });
      const attemptId = message.attemptId ?? crypto.randomUUID();
      const pdfSource = { type: 'url', url: source.url, name: source.name ?? null, sizeBytes: source.sizeBytes ?? null };
      const pdfFolderToken = typeof message.pdfFolderToken === 'string' && message.pdfFolderToken ? message.pdfFolderToken : null;
      const result = await bridge('/v1/jobs', { method: 'POST', body: { attemptId, pdfSource, pdfFolderToken } });
      await chrome.storage.local.set({ activeAttempt: attemptId });
      return result;
    }
    // 弹窗打开时的主 PDF 轻量探测（#65）：注入 pdf-detect.js（只读 meta/location + 一次 HEAD），
    // 不跑正文提取；失败按未识别处理，弹窗不出现 PDF 入口
    case 'DETECT_PDF': {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !/^https?:/.test(tab.url || '')) return { pdf: null };
        if (supportsPdfTranslatorHost()) {
          const translated = await runPdfTranslators(tab);
          const normalized = normalizePdfCandidates(translated.attachments);
          return { pdf: normalized.primary, pdfAttachments: normalized.attachments, diagnostics: [...translated.diagnostics, ...normalized.warnings] };
        }
        const [execution] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['pdf-detect.js'] });
        return execution?.result ?? { pdf: null };
      } catch {
        return { pdf: null };
      }
    }
    // 凭据回传（#68）：弹窗轮询看到 awaiting_bytes 后触发；SW 内 in-flight 去重，
    // 中断重连由 bridge 位图保证只补缺块
    case 'FEED_PDF_BYTES': return feedPdfBytes(message);
    // 任务日志（开发者模式）：bridge 侧统一记录耗时时间线，设置页透传展示
    case 'LIST_JOBS': return bridge('/v1/jobs?limit=20');
    // 预览懒提取（#37）：只抓快照、不建 job；弹窗首次展开预览时调用
    case 'EXTRACT': return extractActiveTab();
    case 'GET_JOB': {
      const result = await bridge(`/v1/jobs/${message.attemptId}`);
      // 双 job（#60）：bridge 返回该 attempt 的全部 job；兼容老 bridge 的单 job 形态
      const jobs = result.jobs ?? (result.job ? [result.job] : []);
      // 跨页面命中旧 attempt（弹窗在未剪藏过的页面打开）：不把 job 返回给弹窗展示。
      // 注意查询永远不清 activeAttempt 指针（终态也不清）：指针只被下一次 CLIP 覆盖。
      // 清掉会让原页面的成功态无从恢复——用户在别的页面开过弹窗，回到原页面就什么都看不到
      if (jobs.length > 0 && message.pageUrl && !jobs.some((job) => isJobForPage(job, message.pageUrl))) {
        return { ...result, job: null, jobs: [] };
      }
      return { ...result, jobs };
    }
    default: throw new Error('UNKNOWN_MESSAGE');
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'pdf-translator-host') return false;
  handle(message).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: { code: error.code || 'ERROR', message: error.message } }));
  return true;
});
