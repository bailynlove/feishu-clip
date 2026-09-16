// PDF Translator Runtime (#108).
//
// The runtime owns the narrow seam between Translator code and the extension. The actual code is
// expected to run in translator-sandbox.html; this module supplies the target/priority selector,
// per-run timeout and the network policy that the sandbox host uses for request RPCs.

export const PDF_TRANSLATOR_BUDGETS = Object.freeze({
  detectTimeoutMs: 1_000,
  doWebTimeoutMs: 15_000,
  maxRequests: 8,
  responseBytes: 5 * 1024 * 1024,
  totalResponseBytes: 20 * 1024 * 1024,
  maxRedirects: 10,
});

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const AUTH_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;

function runtimeError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function originFor(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
    return parsed.origin;
  } catch {
    throw runtimeError('TRANSLATOR_URL_INVALID', 'Translator 请求地址必须是 HTTP(S) URL');
  }
}

function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function') return [...headers.entries()];
  return Object.entries(headers);
}

function headerObject(headers) {
  return Object.fromEntries(headerEntries(headers).map(([name, value]) => [String(name).toLowerCase(), String(value)]));
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function createPdfTranslatorNetworkPolicy({
  pageUrl,
  requestOrigins = [],
  fetchImpl = globalThis.fetch,
  phase = 'doWeb',
  budgets = PDF_TRANSLATOR_BUDGETS,
} = {}) {
  const pageOrigin = originFor(pageUrl);
  const allowedOrigins = new Set([pageOrigin, ...requestOrigins]);
  let requestCount = 0;
  let totalResponseBytes = 0;

  function assertOrigin(url) {
    const origin = originFor(url);
    if (!allowedOrigins.has(origin)) {
      throw runtimeError('TRANSLATOR_ORIGIN_DENIED', `Translator 未声明跨域 origin：${origin}`, { origin });
    }
    return origin;
  }

  async function request({ method = 'GET', url, headers = {}, body } = {}) {
    if (phase === 'detectWeb' || phase === 'detect') throw runtimeError('TRANSLATOR_NETWORK_DISABLED', 'detectWeb 阶段禁止网络请求');
    if (typeof fetchImpl !== 'function') throw runtimeError('TRANSLATOR_NETWORK_UNAVAILABLE', '当前运行时没有受控网络适配器');

    let currentUrl = url;
    let redirects = 0;
    while (true) {
      const origin = assertOrigin(currentUrl);
      const outgoing = Object.fromEntries(headerEntries(headers));
      if (origin !== pageOrigin && Object.keys(outgoing).some((name) => AUTH_HEADER.test(name))) {
        throw runtimeError('TRANSLATOR_CROSS_ORIGIN_CREDENTIALS', '认证信息不能转发到跨域 origin', { origin });
      }
      if (requestCount >= budgets.maxRequests) {
        throw runtimeError('TRANSLATOR_REQUEST_LIMIT', `Translator 请求次数超过 ${budgets.maxRequests} 次`);
      }
      requestCount += 1;
      let response;
      try {
        response = await fetchImpl(currentUrl, {
          method,
          headers: outgoing,
          body,
          credentials: origin === pageOrigin ? 'same-origin' : 'omit',
          redirect: 'manual',
        });
      } catch (error) {
        throw runtimeError('TRANSLATOR_NETWORK_FAILED', error?.message || 'Translator 网络请求失败', { cause: error });
      }

      const headersObject = headerObject(response.headers);
      if (REDIRECTS.has(response.status)) {
        const location = response.headers?.get?.('location') ?? headersObject.location;
        if (!location) throw runtimeError('TRANSLATOR_REDIRECT_INVALID', '重定向缺少 Location');
        redirects += 1;
        if (redirects > budgets.maxRedirects) throw runtimeError('TRANSLATOR_REDIRECT_LIMIT', 'Translator 重定向次数超过限制');
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }

      const declaredLength = Number(headersObject['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > budgets.responseBytes) {
        throw runtimeError('TRANSLATOR_RESPONSE_TOO_LARGE', 'Translator 响应超过单响应体积限制', { bytes: declaredLength });
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > budgets.responseBytes || totalResponseBytes + buffer.byteLength > budgets.totalResponseBytes) {
        throw runtimeError('TRANSLATOR_RESPONSE_TOO_LARGE', 'Translator 响应超过体积预算', { bytes: buffer.byteLength });
      }
      totalResponseBytes += buffer.byteLength;
      const bodyBase64 = bytesToBase64(buffer);
      const bodyText = new TextDecoder().decode(buffer);
      return {
        status: response.status,
        ok: Boolean(response.ok),
        url: currentUrl,
        headers: headersObject,
        bodyText,
        bodyBase64,
      };
    }
  }

  return Object.freeze({ request, get usage() { return { requestCount, totalResponseBytes }; } });
}

export function selectPdfTranslators(entries, pageUrl) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.enabled !== false && entry?.ok === true && entry?.compatibility === 'compatible')
    .filter((entry) => {
      try { return new RegExp(entry.translator.metadata.target || '').test(pageUrl); } catch { return false; }
    })
    .sort((left, right) => left.translator.metadata.priority - right.translator.metadata.priority
      || left.translator.metadata.label.localeCompare(right.translator.metadata.label)
      || left.translator.metadata.translatorID.localeCompare(right.translator.metadata.translatorID));
}

function timeoutError(phase, timeoutMs) {
  return runtimeError('TRANSLATOR_TIMEOUT', `${phase} Translator 执行超过 ${timeoutMs}ms`, { phase, timeoutMs });
}

export function createPdfTranslatorRunner({
  sandboxFactory,
  fetchImpl,
  budgets = PDF_TRANSLATOR_BUDGETS,
  timeoutMs,
} = {}) {
  if (!sandboxFactory?.run) throw new TypeError('sandboxFactory.run is required');

  async function execute(entry, { page, phase = 'detectWeb' } = {}) {
    const effectiveTimeout = timeoutMs ?? (phase === 'detectWeb' ? budgets.detectTimeoutMs : budgets.doWebTimeoutMs);
    const network = createPdfTranslatorNetworkPolicy({
      pageUrl: page.url,
      requestOrigins: entry.translator.metadata.requestOrigins,
      fetchImpl,
      phase,
      budgets,
    });
    const task = sandboxFactory.run({
      translator: entry.translator,
      metadata: entry.translator.metadata,
      page,
      phase,
      request: network.request,
    });
    let timer;
    try {
      return await Promise.race([
        task,
        new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(phase, effectiveTimeout)), effectiveTimeout); }),
      ]);
    } catch (error) {
      if (error?.code === 'TRANSLATOR_TIMEOUT') sandboxFactory.dispose?.(entry.translator.metadata.translatorID);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runDetectionChain({ translators, page } = {}) {
    const diagnostics = [];
    for (const entry of selectPdfTranslators(translators, page.url)) {
      try {
        const result = await execute(entry, { page, phase: 'detectWeb' });
        if (result?.detected === false || !result?.detected) continue;
        const attachments = Array.isArray(result.attachments) ? result.attachments : [];
        if (attachments.length > 0) return { translator: entry, attachments, diagnostics };
      } catch (error) {
        diagnostics.push({ level: 'warning', code: error.code || 'TRANSLATOR_FAILED', message: error.message, translatorID: entry.translator.metadata.translatorID });
      }
    }
    return { translator: null, attachments: [], diagnostics };
  }

  async function runExtraction(entry, { page } = {}) {
    try {
      const result = await execute(entry, { page, phase: 'doWeb' });
      return { translator: entry, attachments: Array.isArray(result?.attachments) ? result.attachments : [], diagnostics: [] };
    } catch (error) {
      return { translator: null, attachments: [], diagnostics: [{ level: 'warning', code: error.code || 'TRANSLATOR_FAILED', message: error.message, translatorID: entry.translator.metadata.translatorID }] };
    }
  }

  return Object.freeze({ execute, runDetectionChain, runExtraction });
}

// Host adapter for extension pages (for example an offscreen document). The iframe is opaque to
// the extension origin: only allow-scripts is granted, so translator code cannot access extension
// APIs, DOM, storage, or cookies. Service-worker callers should create this adapter in an offscreen
// document and forward the resulting RPC methods to the worker.
export function createIframeSandbox({
  documentRef = globalThis.document,
  sandboxUrl = 'translator-sandbox.html',
  loadTimeoutMs = 2_000,
} = {}) {
  if (!documentRef?.createElement) throw new TypeError('documentRef is required for iframe sandbox');
  const frame = documentRef.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = sandboxUrl;
  (documentRef.body || documentRef.documentElement).append(frame);
  const target = frame.contentWindow;
  const runs = new Map();
  let sequence = 0;
  let disposed = false;

  const onMessage = (event) => {
    if (event.source !== target) return;
    const payload = event.data || {};
    if (payload.type === 'result') {
      const run = runs.get(payload.runId);
      if (!run) return;
      runs.delete(payload.runId);
      payload.ok ? run.resolve(payload.result) : run.reject(runtimeError(payload.error?.code || 'TRANSLATOR_EXECUTION_FAILED', payload.error?.message || 'Translator 执行失败'));
      return;
    }
    if (payload.type !== 'request') return;
    const run = runs.get(payload.runId);
    if (!run) return;
    Promise.resolve().then(() => run.request(payload.request)).then(
      (result) => target.postMessage({ type: 'response', runId: payload.runId, requestId: payload.requestId, ok: true, result }, '*'),
      (error) => target.postMessage({ type: 'response', runId: payload.runId, requestId: payload.requestId, ok: false, error: { code: error.code || 'TRANSLATOR_NETWORK_FAILED', message: error.message } }, '*'),
    );
  };
  documentRef.defaultView?.addEventListener('message', onMessage);

  function run({ translator, metadata, page, phase, request }) {
    if (disposed) return Promise.reject(runtimeError('TRANSLATOR_SANDBOX_DISPOSED', 'Translator sandbox 已销毁'));
    const runId = `run:${++sequence}`;
    return new Promise((resolve, reject) => {
      runs.set(runId, { resolve, reject, request });
      target.postMessage({ type: 'run', runId, translator: { code: translator.code, metadata }, page, phase }, '*');
    });
  }

  function dispose(runId) {
    if (runId) {
      const run = runs.get(runId);
      if (run) { runs.delete(runId); run.reject(runtimeError('TRANSLATOR_SANDBOX_DISPOSED', 'Translator sandbox 已销毁')); }
    }
    if (disposed) return;
    disposed = true;
    for (const run of runs.values()) run.reject(runtimeError('TRANSLATOR_SANDBOX_DISPOSED', 'Translator sandbox 已销毁'));
    runs.clear();
    documentRef.defaultView?.removeEventListener('message', onMessage);
    frame.remove();
  }

  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(runtimeError('TRANSLATOR_SANDBOX_LOAD_TIMEOUT', 'Translator sandbox 加载超时')), loadTimeoutMs);
    frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    frame.addEventListener('error', () => { clearTimeout(timer); reject(runtimeError('TRANSLATOR_SANDBOX_LOAD_FAILED', 'Translator sandbox 加载失败')); }, { once: true });
  });
  return Object.freeze({ run: async (args) => { await loaded; return run(args); }, dispose });
}
