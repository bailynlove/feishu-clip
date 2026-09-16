// MV3 sandbox runtime for community PDF translators.
// This file deliberately has no extension APIs and never performs network I/O. All requests are
// RPCs to the extension page, where pdf-translator-runtime.js applies the origin and byte policy.
(function installTranslatorSandbox() {
  const pending = new Map();
  let sequence = 0;

  function send(target, message) {
    target?.postMessage(message, '*');
  }

  function rpc(target, runId, request) {
    const requestId = `${runId}:${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      send(target, { type: 'request', runId, requestId, request });
    });
  }

  function responseFromRpc(payload) {
    const current = pending.get(payload.requestId);
    if (!current) return;
    pending.delete(payload.requestId);
    if (payload.ok) current.resolve(payload.result);
    else current.reject(Object.assign(new Error(payload.error?.message || 'Translator 请求失败'), payload.error));
  }

  function responseLike(result) {
    const bytes = Uint8Array.from(atob(result.bodyBase64 || ''), (character) => character.charCodeAt(0));
    return {
      status: result.status,
      ok: result.ok,
      url: result.url,
      headers: { get(name) { return result.headers?.[String(name).toLowerCase()] ?? null; } },
      text: async () => result.bodyText ?? new TextDecoder().decode(bytes),
      json: async () => JSON.parse(result.bodyText ?? new TextDecoder().decode(bytes)),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }

  function parsePage(html) {
    const parsed = new DOMParser().parseFromString(String(html || '<html></html>'), 'text/html');
    return parsed || document.implementation.createHTMLDocument('translator-page');
  }

  function xpath(node, expression) {
    const owner = node?.ownerDocument || node;
    const result = owner.evaluate(expression, node, null, XPathResult.ANY_TYPE, null);
    if (result.resultType === XPathResult.STRING_TYPE) return result.stringValue;
    if (result.resultType === XPathResult.NUMBER_TYPE) return result.numberValue;
    if (result.resultType === XPathResult.BOOLEAN_TYPE) return result.booleanValue;
    if (result.resultType === XPathResult.UNORDERED_NODE_ITERATOR_TYPE) {
      const nodes = [];
      let current;
      while ((current = result.iterateNext())) nodes.push(current);
      return nodes;
    }
    return result.singleNodeValue;
  }

  function buildApis(target, runId, pageUrl, items) {
    class Item {
      constructor(type = 'journalArticle') {
        this.itemType = type;
        this.attachments = [];
        this.creators = [];
        this.tags = [];
        this.notes = [];
        this.seeAlso = [];
        this._completed = false;
      }
      complete() { this._completed = true; items.push(this); return this; }
      setField(field, value) { this[field] = value; }
      getField(field) { return this[field]; }
    }
    const request = (method, url, options = {}) => rpc(target, runId, {
      method, url: new URL(url, pageUrl).href, headers: options.headers || {}, body: options.body,
    }).then(responseLike);
    const Zotero = {
      Item,
      HTTP: { request },
      Utilities: {
        trimInternal: (value) => String(value ?? '').replace(/\s+/g, ' ').trim(),
        cleanAuthor: (firstName, lastName, creatorType = 'author') => ({ firstName, lastName, creatorType }),
        strToISO: (value) => value,
        capitalizeTitle: (value) => String(value ?? '').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      },
    };
    const ZU = {
      doGet: (url, processor, options) => request('GET', url, options).then((result) => processor(result)),
      doPost: (url, body, processor, options = {}) => request('POST', url, { ...options, body }).then((result) => processor(result)),
      processDocuments: async (urls, processor, done) => {
        for (const url of Array.isArray(urls) ? urls : [urls]) {
          const result = await request('GET', url);
          await processor(parsePage(await result.text()), result.url);
        }
        if (done) done();
      },
      xpath,
      xpathText: (node, expression) => {
        const value = xpath(node, expression);
        return Array.isArray(value) ? value.map((item) => item.textContent || '').join(' ') : value?.textContent || value || '';
      },
      attr: (node, name) => node?.getAttribute?.(name) || '',
      text: (node) => node?.textContent || '',
      trimInternal: Zotero.Utilities.trimInternal,
      cleanAuthor: Zotero.Utilities.cleanAuthor,
      strToISO: Zotero.Utilities.strToISO,
      capitalizeTitle: Zotero.Utilities.capitalizeTitle,
    };
    return { Zotero, ZU };
  }

  async function execute(event, payload) {
    const items = [];
    const { Zotero, ZU } = buildApis(event.source, payload.runId, payload.page?.url || location.href, items);
    const page = parsePage(payload.page?.html);
    const locationObject = new URL(payload.page?.url || location.href);
    const exports = new Function('document', 'location', 'Zotero', 'ZU',
      `'use strict';\n${payload.translator.code}\nreturn { detectWeb: typeof detectWeb === 'function' ? detectWeb : null, doWeb: typeof doWeb === 'function' ? doWeb : null };`)(page, locationObject, Zotero, ZU);
    if (payload.phase === 'detectWeb') {
      const detection = exports.detectWeb ? await exports.detectWeb(page, locationObject.href) : false;
      return { detected: Boolean(detection), detection, attachments: [] };
    }
    if (!exports.doWeb) throw new Error('Translator 缺少 doWeb');
    await exports.doWeb(page, locationObject.href);
    const attachments = items.flatMap((item) => item.attachments || []).filter((attachment) => attachment?.url);
    return { detected: true, attachments };
  }

  window.addEventListener('message', async (event) => {
    const payload = event.data || {};
    if (payload.type === 'response') return responseFromRpc(payload);
    if (payload.type !== 'run' || !event.source) return;
    try {
      const result = await execute(event, payload);
      send(event.source, { type: 'result', runId: payload.runId, ok: true, result });
    } catch (error) {
      send(event.source, {
        type: 'result', runId: payload.runId, ok: false,
        error: { code: error.code || 'TRANSLATOR_EXECUTION_FAILED', message: error.message || String(error) },
      });
    }
  });
})();
