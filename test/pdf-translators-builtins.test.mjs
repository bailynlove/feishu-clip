import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { BUILT_IN_PDF_TRANSLATORS, createBuiltInPdfTranslatorEntries } from '../src/extension/pdf-translators-builtins.js';
import { PAPER_SITES, PAPER_TRIGGER_RULES } from '../src/extension/paper-sites.js';

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
  const entry = (await createBuiltInPdfTranslatorEntries({ readText }))
    .find((item) => item.translator.metadata.label === 'Hugging Face PDF');
  const [result] = execute(entry, 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf');
  assert.deepEqual(result, {
    url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/DeepSeek_V41_Tech_Report.pdf',
    title: 'DeepSeek_V41_Tech_Report.pdf', mimeType: 'application/pdf', primary: true,
  });
});

test('every paper trigger site has an enabled Zotero-style file before the generic fallback', async () => {
  assert.equal(PAPER_SITES.length, 34);
  assert.equal(PAPER_TRIGGER_RULES.split('\n').length, PAPER_SITES.length);
  assert.deepEqual(BUILT_IN_PDF_TRANSLATORS.slice(0, -1).map((item) => item.path), PAPER_SITES.map((item) => item.path));
  assert.equal(BUILT_IN_PDF_TRANSLATORS.at(-1).path, './pdf-translators/citation-pdf-url.js');
  const entries = await createBuiltInPdfTranslatorEntries({ readText });
  assert.equal(entries.every((item) => item.ok && item.enabled && item.source === 'builtin'), true);
  assert.equal(entries.length, 35);
  assert.deepEqual(entries.map((item) => item.filePath), BUILT_IN_PDF_TRANSLATORS.map((item) => `扩展目录/${item.path.replace(/^\.\//, '')}`));
  assert.equal(execute(entries[0], 'https://arxiv.org/abs/2401.12345')[0].url, 'https://arxiv.org/pdf/2401.12345');
  assert.equal(execute(entries.at(-1), 'https://example.test/paper', '/files/paper.pdf')[0].url, 'https://example.test/files/paper.pdf');
});

test('representative Zotero-derived site rules build stable PDF URLs', async () => {
  const entries = await createBuiltInPdfTranslatorEntries({ readText });
  const byLabel = (label) => entries.find((entry) => entry.translator.metadata.label === label);
  assert.equal(execute(byLabel('IEEE Xplore PDF'), 'https://ieeexplore.ieee.org/document/1234567')[0].url,
    'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=1234567&ref=');
  assert.equal(execute(byLabel('APS Journals PDF'), 'https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.1.1')[0].url,
    'https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.1.1');
  assert.equal(execute(byLabel('OpenReview PDF'), 'https://openreview.net/forum?id=abc123')[0].url,
    'https://openreview.net/pdf?id=abc123');
  assert.equal(execute(byLabel('ACL Anthology PDF'), 'https://aclanthology.org/2024.acl-long.1/')[0].url,
    'https://aclanthology.org/2024.acl-long.1.pdf');
  assert.equal(execute(byLabel('PMLR PDF'), 'https://proceedings.mlr.press/v235/example24a.html')[0].url,
    'https://proceedings.mlr.press/v235/example24a/example24a.pdf');
  assert.equal(execute(byLabel('Hugging Face PDF'), 'https://huggingface.co/papers/2401.12345')[0].url,
    'https://arxiv.org/pdf/2401.12345');
});
