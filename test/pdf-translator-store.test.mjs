import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { effectivePdfTranslatorRegistry, normalizePdfTranslatorEntries, pdfTranslatorDisplayNames, pdfTranslatorView, removePdfTranslator, setPdfTranslatorEnabled, upsertPdfTranslator } from '../src/extension/pdf-translator-store.js';

const readText = (path) => readFile(new URL(`../src/extension/${path.replace(/^\.\//, '')}`, import.meta.url), 'utf8');

const entry = (id = 'one') => ({ ok: true, compatibility: 'compatible', enabled: true, confirmed: true, translator: { metadata: { translatorID: id, label: id, creator: 'Author', priority: 1, requestOrigins: [] }, code: 'function doWeb(){}', source: 'source' } });

test('normalizes and upserts multiple imported translator files by stable ID', () => {
  const first = upsertPdfTranslator([], entry());
  const second = upsertPdfTranslator(first, entry('two'));
  assert.deepEqual(second.map((item) => item.translator.metadata.translatorID), ['one', 'two']);
  const replacement = upsertPdfTranslator(second, { ...entry(), enabled: false });
  assert.equal(replacement.length, 2);
  assert.equal(replacement[0].enabled, false);
});

test('toggle, remove, and display preserve current file state', () => {
  const entries = [entry(), entry('two')];
  entries[0].filePath = '/Users/example/Paper.js';
  const disabled = setPdfTranslatorEnabled(entries, 'two', false);
  assert.equal(pdfTranslatorView(disabled[1]).enabled, false);
  assert.equal(pdfTranslatorView(disabled[0]).filePath, '/Users/example/Paper.js');
  assert.equal(pdfTranslatorView(disabled[1]).filePath, '本机文件/two.js');
  assert.equal(removePdfTranslator(disabled, 'one').length, 1);
  assert.equal(normalizePdfTranslatorEntries(null).length, 0);
});

test('effective registry exposes loaded built-in files, user overrides and rejected imports', async () => {
  const builtInId = '2b9c4f21-3c8a-4a7b-8c10-000000000001';
  const override = entry(builtInId);
  override.translator.metadata.label = 'Override';
  const registry = await effectivePdfTranslatorRegistry([
    entry('community'),
    override,
    { ...entry('broken'), ok: false, compatibility: 'incompatible' },
  ], [builtInId], { readText });
  assert.ok(registry.selected.some((item) => item.source === 'builtin'));
  assert.equal(registry.selected.find((item) => item.translator.metadata.translatorID === builtInId).translator.metadata.label, 'Override');
  assert.equal(registry.active.some((item) => item.translator.metadata.translatorID === builtInId), true);
  assert.deepEqual(registry.rejected.map((item) => item.translator.metadata.translatorID), ['broken']);
});

test('display names add sequence numbers only when labels repeat', () => {
  assert.deepEqual(pdfTranslatorDisplayNames([entry('one'), entry('two'), entry('three')]), ['one', 'two', 'three']);
  const repeated = [entry('one'), entry('two'), entry('three')];
  repeated.forEach((item) => { item.translator.metadata.label = 'Paper'; });
  assert.deepEqual(pdfTranslatorDisplayNames(repeated), ['Paper (1)', 'Paper (2)', 'Paper (3)']);
});
