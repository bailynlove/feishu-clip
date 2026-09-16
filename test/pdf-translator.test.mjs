import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  normalizePdfAttachments,
  parsePdfTranslatorFile,
  resolvePdfTranslatorVersions,
} from '../src/extension/pdf-translator.js';

// Unmodified upstream file from zotero/translators (AGPL-3.0-or-later), downloaded 2026-09-16:
// https://github.com/zotero/translators/blob/master/Google%20Presentation.js
const compatibleSource = await readFile(new URL('./fixtures/pdf-translators/zotero-google-presentation.js', import.meta.url), 'utf8');
const incompatibleSource = await readFile(new URL('./fixtures/pdf-translators/incompatible-zotero.js', import.meta.url), 'utf8');

test('parses an unchanged Zotero-style translator and normalizes its contract metadata', () => {
  const result = parsePdfTranslatorFile(compatibleSource);

  assert.equal(result.ok, true);
  assert.equal(result.compatibility, 'compatible');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.translator.metadata, {
    translatorID: 'c114f9fd-6387-4387-853d-fcfe5ab3ac0a',
    label: 'Google Presentation',
    creator: 'Philipp Zumstein',
    target: '^https?://docs\\.google\\.com/presentation/d/',
    priority: 100,
    version: '2024-02-19 09:33:28',
    requestOrigins: [],
    translatorType: 4,
  });
  assert.match(result.translator.code, /function detectWeb/);
});

test('marks unsupported Zotero capabilities incompatible at import time', () => {
  const result = parsePdfTranslatorFile(incompatibleSource);

  assert.equal(result.ok, true, 'the file is structurally valid and can remain visible in settings');
  assert.equal(result.compatibility, 'incompatible');
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), [
    'UNSUPPORTED_MULTIPLE_SELECTION',
    'UNSUPPORTED_NESTED_TRANSLATOR',
    'UNSUPPORTED_LIBRARY_ACCESS',
  ]);
  assert.ok(result.diagnostics.every((entry) => entry.level === 'error'));
});

test('ignores API-looking text in comments and string literals', () => {
  const source = compatibleSource.replace(
    'function detectWeb',
    '// Zotero.selectItems({}); Zotero.loadTranslator("import");\nconst note = "Zotero.Search";\nfunction detectWeb',
  );
  const result = parsePdfTranslatorFile(source);

  assert.equal(result.compatibility, 'compatible');
  assert.deepEqual(result.diagnostics, []);
});

test('rejects malformed headers and invalid required metadata without attempting execution', () => {
  const missingHeader = parsePdfTranslatorFile('function detectWeb() {}\nfunction doWeb() {}');
  assert.equal(missingHeader.ok, false);
  assert.equal(missingHeader.diagnostics[0].code, 'METADATA_HEADER_REQUIRED');

  const invalid = parsePdfTranslatorFile(`{
    "translatorID": "not stable",
    "label": "",
    "creator": "Tests",
    "target": "[",
    "priority": 1.5,
    "translatorType": 1,
    "requestOrigins": ["https://cdn.example/path", "ftp://files.example"]
  }
  function detectWeb() { return true; }
  `);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.diagnostics.map((entry) => entry.code), [
    'INVALID_TRANSLATOR_ID',
    'LABEL_REQUIRED',
    'INVALID_TARGET',
    'INVALID_PRIORITY',
    'WEB_TRANSLATOR_REQUIRED',
    'VERSION_REQUIRED',
    'INVALID_REQUEST_ORIGIN',
    'DO_WEB_REQUIRED',
  ]);
});

test('normalizes request origins to exact origins and removes duplicates', () => {
  const source = compatibleSource
    .replace(
      '"lastUpdated": "2024-02-19 09:33:28"',
      '"lastUpdated": "2024-02-19 09:33:28",\n\t"requestOrigins": ["https://CDN.example:443", "https://cdn.example"]',
    );
  const result = parsePdfTranslatorFile(source);

  assert.equal(result.ok, true);
  assert.deepEqual(result.translator.metadata.requestOrigins, ['https://cdn.example']);
});

test('requires a usable version or Zotero lastUpdated value', () => {
  const missing = parsePdfTranslatorFile(compatibleSource.replace(/,\n\t"lastUpdated": "[^"]+"/, ''));
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((entry) => entry.code === 'VERSION_REQUIRED'));

  const invalid = parsePdfTranslatorFile(compatibleSource.replace('"lastUpdated": "2024-02-19 09:33:28"', '"lastUpdated": {"bad": true}'));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.diagnostics.some((entry) => entry.code === 'INVALID_VERSION'));
});

test('unknown direct Zotero or ZU members are incompatible instead of failing silently at runtime', () => {
  const source = compatibleSource.replace(
    'item.complete();',
    'Zotero.magic(item);\n\tZU.unknownHelper(doc);\n\titem.complete();',
  );
  const result = parsePdfTranslatorFile(source);

  assert.equal(result.compatibility, 'incompatible');
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), [
    'UNSUPPORTED_ZOTERO_API',
    'UNSUPPORTED_ZOTERO_API',
  ]);
  assert.match(result.diagnostics[0].message, /Zotero\.magic/);
  assert.match(result.diagnostics[1].message, /ZU\.unknownHelper/);
});

test('conservatively rejects computed, aliased and template-expression Zotero access', () => {
  const source = compatibleSource.replace(
    'function detectWeb',
    'const Alias = Zotero;\nZotero["selectItems"]({});\nconst marker = `${Zotero.loadTranslator("web")}`;\nfunction detectWeb',
  );
  const result = parsePdfTranslatorFile(source);

  assert.equal(result.compatibility, 'incompatible');
  assert.ok(result.diagnostics.filter((entry) => entry.code === 'UNANALYZABLE_ZOTERO_ACCESS').length >= 2);
  assert.ok(result.diagnostics.some((entry) => entry.code === 'UNSUPPORTED_NESTED_TRANSLATOR'));
});

test('resolves one active version per translatorID, sorts by priority and restores built-ins after removal', () => {
  const builtInA = parsePdfTranslatorFile(compatibleSource);
  const builtInB = parsePdfTranslatorFile(compatibleSource
    .replace('c114f9fd-6387-4387-853d-fcfe5ab3ac0a', 'd9d7a63b-7090-4d94-8b4f-4f5f64362a1d')
    .replace('"label": "Google Presentation"', '"label": "Second Built-in"')
    .replace('"priority": 100', '"priority": 20'));
  const importedA = parsePdfTranslatorFile(compatibleSource
    .replace('"label": "Google Presentation"', '"label": "User Google Presentation"')
    .replace('"priority": 100', '"priority": 10')
    .replace('"lastUpdated": "2024-02-19 09:33:28"', '"lastUpdated": "2026-09-16 12:00:00"'));

  const overridden = resolvePdfTranslatorVersions({ builtIn: [builtInA, builtInB], imported: [importedA] });
  assert.deepEqual(overridden.active.map((entry) => entry.translator.metadata.label), [
    'User Google Presentation',
    'Second Built-in',
  ]);
  assert.equal(overridden.shadowed[0], builtInA);
  assert.equal(overridden.selected.length, 2, '同一 translatorID 只选择一个版本');

  const restored = resolvePdfTranslatorVersions({ builtIn: [builtInA, builtInB], imported: [] });
  assert.deepEqual(restored.active.map((entry) => entry.translator.metadata.label), [
    'Second Built-in',
    'Google Presentation',
  ]);

  const disabledOverride = resolvePdfTranslatorVersions({
    builtIn: [builtInA, builtInB],
    imported: [{ ...importedA, enabled: false }],
  });
  assert.deepEqual(disabledOverride.active.map((entry) => entry.translator.metadata.label), ['Second Built-in']);
});

test('does not let an incompatible user file silently disable a working built-in version', () => {
  const builtIn = parsePdfTranslatorFile(compatibleSource);
  const incompatible = parsePdfTranslatorFile(incompatibleSource.replace(
    'b12b8f6a-3d43-4f7d-88be-1481640bd8f1',
    'c114f9fd-6387-4387-853d-fcfe5ab3ac0a',
  ));
  const result = resolvePdfTranslatorVersions({ builtIn: [builtIn], imported: [incompatible] });

  assert.deepEqual(result.active.map((entry) => entry.translator.metadata.label), ['Google Presentation']);
  assert.deepEqual(result.rejected, [incompatible]);
  assert.deepEqual(result.shadowed, []);
});

test('normalizes, resolves and de-duplicates PDF attachments while preserving translator order', () => {
  const result = normalizePdfAttachments([
    { url: '/paper.pdf#page=2', title: 'Main paper', mimeType: 'application/pdf', primary: true },
    { url: 'https://papers.example/paper.pdf', title: 'Duplicate PDF', mimeType: 'application/pdf' },
    { url: 'https://cdn.example/supplement?id=7', name: 'supplement.pdf', mimeType: 'application/pdf' },
  ], { baseUrl: 'https://papers.example/article/42' });

  assert.deepEqual(result.candidates, [
    { url: 'https://papers.example/paper.pdf', name: 'Main paper', order: 0, primary: true },
    { url: 'https://cdn.example/supplement?id=7', name: 'supplement.pdf', order: 2, primary: false },
  ]);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), ['DUPLICATE_ATTACHMENT']);
});

test('keeps only the first primary marker and reports the translator conflict', () => {
  const result = normalizePdfAttachments([
    { url: 'https://papers.example/main.pdf', primary: true },
    { url: 'https://papers.example/supp.pdf', primary: true },
  ]);

  assert.equal(result.candidates[0].primary, true);
  assert.equal(result.candidates[1].primary, false);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), ['MULTIPLE_PRIMARY_ATTACHMENTS']);
});

test('uses the first PDF as primary when none is marked and rejects unsafe or non-PDF attachments', () => {
  const result = normalizePdfAttachments([
    { url: 'javascript:alert(1)', mimeType: 'application/pdf' },
    { url: 'https://papers.example/readme.html', title: 'Landing page', mimeType: 'text/html' },
    { url: 'https://papers.example/download?file=paper', title: 'Full Text', mimeType: 'application/pdf' },
  ]);

  assert.deepEqual(result.candidates, [
    { url: 'https://papers.example/download?file=paper', name: 'Full Text', order: 2, primary: true },
  ]);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), [
    'INVALID_ATTACHMENT_URL',
    'NON_PDF_ATTACHMENT',
  ]);
});
