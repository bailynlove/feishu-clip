import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname);

test('manifest exposes a scripts-only translator sandbox', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/extension/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.sandbox.pages, ['translator-sandbox.html']);
  const html = fs.readFileSync(path.join(root, 'src/extension/translator-sandbox.html'), 'utf8');
  assert.match(html, /script-src 'self' 'unsafe-eval'/);
  assert.match(html, /translator-sandbox\.js/);
});

test('sandbox runtime has no direct network or extension API access', () => {
  const source = fs.readFileSync(path.join(root, 'src/extension/translator-sandbox.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|chrome\.|browser\.)/);
  assert.match(source, /postMessage/);
  assert.match(source, /new Function/);
});
