import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { BUILT_IN_PDF_TRANSLATORS, createBuiltInPdfTranslatorEntries } from '../src/extension/pdf-translators-builtins.js';

const readText = (path) => readFile(new URL(`../src/extension/${path.replace(/^\.\//, '')}`, import.meta.url), 'utf8');

function execute(entry, url, citationPdfUrl = null) {
  const items = [];
  class Item {
    constructor() { this.attachments = []; }
    complete() { items.push(this); }
  }
  const document = { querySelector: () => (citationPdfUrl ? { getAttribute: () => citationPdfUrl } : null) };
  const exports = new Function('document', 'Zotero', `${entry.translator.code}\nreturn { detectWeb, doWeb };`)(document, { Item });
  const detected = exports.detectWeb(document, url);
  if (detected) exports.doWeb(document, url);
  return items.flatMap((item) => item.attachments);
}

test('Hugging Face DeepSeek V4.1 report resolves to a downloadable PDF candidate', async () => {
  const entry = (await createBuiltInPdfTranslatorEntries({ readText }))[1];
  const [result] = execute(entry, 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf');
  assert.deepEqual(result, {
    url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/DeepSeek_V41_Tech_Report.pdf',
    title: 'DeepSeek_V41_Tech_Report.pdf', mimeType: 'application/pdf', primary: true,
  });
});

test('built-in registry loads enabled Zotero-style files in fallback order', async () => {
  assert.deepEqual(BUILT_IN_PDF_TRANSLATORS.map((item) => item.label), ['arXiv PDF', 'Hugging Face PDF', 'citation_pdf_url']);
  assert.deepEqual(BUILT_IN_PDF_TRANSLATORS.map((item) => item.path), [
    './pdf-translators/arxiv.js', './pdf-translators/hugging-face.js', './pdf-translators/citation-pdf-url.js',
  ]);
  const entries = await createBuiltInPdfTranslatorEntries({ readText });
  assert.equal(entries.every((item) => item.ok && item.enabled && item.source === 'builtin'), true);
  assert.equal(execute(entries[0], 'https://arxiv.org/abs/2401.12345')[0].url, 'https://arxiv.org/pdf/2401.12345');
  assert.equal(execute(entries[2], 'https://example.test/paper', '/files/paper.pdf')[0].url, 'https://example.test/files/paper.pdf');
});
