import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILT_IN_PDF_TRANSLATORS, createBuiltInPdfTranslatorEntries, detectBuiltInPdf } from '../src/extension/pdf-translators-builtins.js';

test('Hugging Face DeepSeek V4.1 report resolves to a downloadable PDF candidate', () => {
  const result = detectBuiltInPdf('https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf');
  assert.deepEqual(result, {
    url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/DeepSeek_V41_Tech_Report.pdf',
    name: 'DeepSeek_V41_Tech_Report.pdf',
    translatorID: '2b9c4f21-3c8a-4a7b-8c10-000000000002',
  });
});

test('built-in registry keeps arXiv and citation PDF fallbacks ordered', () => {
  assert.deepEqual(BUILT_IN_PDF_TRANSLATORS.map((item) => item.label), ['arXiv PDF', 'Hugging Face PDF', 'citation_pdf_url']);
  assert.equal(createBuiltInPdfTranslatorEntries().every((item) => item.ok && item.source === 'builtin'), true);
  assert.equal(detectBuiltInPdf('https://arxiv.org/abs/2401.12345').url, 'https://arxiv.org/pdf/2401.12345');
  assert.equal(detectBuiltInPdf('https://example.test/paper', '/files/paper.pdf').name, 'paper.pdf');
});
