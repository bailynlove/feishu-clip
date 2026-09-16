import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePdfCandidates, primaryPdfForAi } from '../src/extension/pdf-attachments.js';

test('normalizes, deduplicates, limits candidates, and chooses first primary', () => {
  const result = normalizePdfCandidates([
    { url: 'https://example.test/a.pdf#x', primary: true },
    { url: 'https://example.test/a.pdf' },
    { url: 'https://example.test/b.pdf', primary: true },
  ]);
  assert.equal(result.attachments.length, 2);
  assert.equal(result.primary.url, 'https://example.test/a.pdf');
  assert.equal(result.attachments[1].primary, false);
  assert.match(result.warnings.join(' '), /去重/);
});

test('preserves translator candidate identity while applying upload budgets', () => {
  const result = normalizePdfCandidates([
    { id: 'supplement', url: 'https://example.test/supplement.pdf', name: 'supplement.pdf' },
    { id: 'main-paper', url: 'https://example.test/main.pdf', primary: true, translatorID: 'translator-1' },
  ]);
  assert.deepEqual(result.attachments.map(({ id, primary, translatorID }) => ({ id, primary, translatorID })), [
    { id: 'supplement', primary: false, translatorID: null },
    { id: 'main-paper', primary: true, translatorID: 'translator-1' },
  ]);
});

test('AI receives only a usable primary PDF', () => {
  const result = normalizePdfCandidates([{ url: 'https://example.test/a.pdf', sizeBytes: 33 * 1024 * 1024 }]);
  assert.equal(primaryPdfForAi(result).attachment, null);
  assert.match(primaryPdfForAi(result).warning, /超过/);
});
