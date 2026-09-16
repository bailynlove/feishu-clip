import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PDF_TRANSLATOR_BUDGETS,
  createPdfTranslatorNetworkPolicy,
  createPdfTranslatorRunner,
  selectPdfTranslators,
} from '../src/extension/pdf-translator-runtime.js';

function translator(label, target, priority, overrides = {}) {
  return {
    ok: true,
    compatibility: 'compatible',
    translator: {
      metadata: {
        translatorID: `${label.toLowerCase()}-0000-4000-8000-000000000000`,
        label,
        target,
        priority,
        requestOrigins: [],
      },
      code: 'function detectWeb() {} function doWeb() {}',
    },
    ...overrides,
  };
}

function response({ status = 200, body = '', headers = {}, location = null } = {}) {
  const values = new Map(Object.entries({ 'content-type': 'text/plain', ...headers }));
  if (location) values.set('location', location);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => values.get(name.toLowerCase()) ?? null,
      entries: () => values.entries(),
    },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

test('selects only compatible matching translators in ascending priority order', () => {
  const selected = selectPdfTranslators([
    translator('Generic', '^https://example\\.test/', 100),
    translator('Specific', '^https://example\\.test/paper', 10),
    translator('Other', '^https://other\\.test/', 1),
    translator('Disabled', '^https://example\\.test/', 0, { enabled: false }),
    translator('Broken', '^https://example\\.test/', 2, { ok: false }),
  ], 'https://example.test/paper/42');

  assert.deepEqual(selected.map((entry) => entry.translator.metadata.label), ['Specific', 'Generic']);
});

test('detect phase rejects network access while doWeb enforces origin and request budgets', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ body: 'ok' });
  };
  const detect = createPdfTranslatorNetworkPolicy({ pageUrl: 'https://papers.example/article', fetchImpl, phase: 'detect' });
  await assert.rejects(() => detect.request({ url: 'https://papers.example/article' }), { code: 'TRANSLATOR_NETWORK_DISABLED' });
  assert.equal(calls.length, 0);

  const policy = createPdfTranslatorNetworkPolicy({
    pageUrl: 'https://papers.example/article',
    requestOrigins: ['https://cdn.example'],
    fetchImpl,
    phase: 'doWeb',
  });
  await policy.request({ url: 'https://papers.example/article' });
  await policy.request({ url: 'https://cdn.example/data' });
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[1].options.credentials, 'omit');
  await assert.rejects(() => policy.request({ url: 'https://not-declared.example/data' }), { code: 'TRANSLATOR_ORIGIN_DENIED' });
  await assert.rejects(() => policy.request({ url: 'https://cdn.example/data', headers: { Authorization: 'Bearer secret' } }), { code: 'TRANSLATOR_CROSS_ORIGIN_CREDENTIALS' });
});

test('rechecks every redirect hop and limits response bytes and aggregate bytes', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/start')) return response({ status: 302, location: 'https://cdn.example/next' });
    return response({ body: 'done', headers: { 'content-length': '4' } });
  };
  const policy = createPdfTranslatorNetworkPolicy({
    pageUrl: 'https://papers.example/article',
    requestOrigins: ['https://cdn.example'],
    fetchImpl,
    phase: 'doWeb',
  });
  const result = await policy.request({ url: 'https://papers.example/start' });
  assert.equal(result.url, 'https://cdn.example/next');
  assert.deepEqual(calls, ['https://papers.example/start', 'https://cdn.example/next']);

  const deniedRedirect = createPdfTranslatorNetworkPolicy({
    pageUrl: 'https://papers.example/article',
    requestOrigins: ['https://cdn.example'],
    fetchImpl: async () => response({ status: 302, location: 'https://evil.example/next' }),
    phase: 'doWeb',
  });
  await assert.rejects(() => deniedRedirect.request({ url: 'https://papers.example/start' }), { code: 'TRANSLATOR_ORIGIN_DENIED' });

  const tooLarge = createPdfTranslatorNetworkPolicy({
    pageUrl: 'https://papers.example/article',
    fetchImpl: async () => response({ body: 'x'.repeat(PDF_TRANSLATOR_BUDGETS.responseBytes + 1) }),
    phase: 'doWeb',
  });
  await assert.rejects(() => tooLarge.request({ url: 'https://papers.example/large' }), { code: 'TRANSLATOR_RESPONSE_TOO_LARGE' });
});

test('runner isolates timeout/errors and falls through to the next matching translator', async () => {
  const first = translator('First', '^https://example\\.test/', 1);
  const second = translator('Second', '^https://example\\.test/', 2);
  const disposed = [];
  const runner = createPdfTranslatorRunner({
    sandboxFactory: {
      async run({ translator: current }) {
        if (current.metadata.label === 'First') await new Promise(() => {});
        return { detected: true, attachments: [{ url: 'https://example.test/paper.pdf' }] };
      },
      dispose(label) { disposed.push(label); },
    },
    timeoutMs: 15,
  });
  const result = await runner.runDetectionChain({
    translators: [first, second],
    page: { url: 'https://example.test/paper' },
  });
  assert.equal(result.translator.translator.metadata.label, 'Second');
  assert.equal(result.attachments.length, 1);
  assert.equal(result.diagnostics[0].code, 'TRANSLATOR_TIMEOUT');
  assert.deepEqual(disposed, [first.translator.metadata.translatorID]);
});

test('runner stops on the first translator that returns PDF attachments', async () => {
  const calls = [];
  const runner = createPdfTranslatorRunner({
    sandboxFactory: {
      async run({ translator: current }) {
        calls.push(current.metadata.label);
        return current.metadata.label === 'Winner'
          ? { detected: true, attachments: [{ url: 'https://example.test/main.pdf' }] }
          : { detected: false, attachments: [] };
      },
    },
    timeoutMs: 100,
  });
  const result = await runner.runDetectionChain({
    translators: [translator('Loser', '^https://example\\.test/', 1), translator('Winner', '^https://example\\.test/', 2)],
    page: { url: 'https://example.test/paper' },
  });
  assert.equal(result.translator.translator.metadata.label, 'Winner');
  assert.deepEqual(calls, ['Loser', 'Winner']);
});

test('runner executes doWeb after detectWeb matches and returns extracted attachments', async () => {
  const phases = [];
  const entry = translator('Paper', '^https://example\\.test/', 1);
  const runner = createPdfTranslatorRunner({
    sandboxFactory: {
      async run({ phase }) {
        phases.push(phase);
        return phase === 'detectWeb'
          ? { detected: true, detection: 'journalArticle', attachments: [] }
          : { attachments: [{ url: 'https://example.test/main.pdf', mimeType: 'application/pdf' }] };
      },
    },
  });
  const result = await runner.runDetectionChain({ translators: [entry], page: { url: 'https://example.test/paper' } });
  assert.deepEqual(phases, ['detectWeb', 'doWeb']);
  assert.equal(result.translator, entry);
  assert.equal(result.attachments[0].url, 'https://example.test/main.pdf');
});
