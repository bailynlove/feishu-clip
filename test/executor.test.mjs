import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareMarkdown } from '../src/bridge/executor.mjs';

test('snapshot markers become traceable image anchors and unsafe sources are plain text', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]\n\n[[FEISHU_CLIP_IMAGE:1]]',
    images: [
      { label: 'public', source: 'https://cdn.example.com/a.png' },
      { label: 'blob', source: 'blob:https://example.com/id', bytesBase64: 'AA==' },
    ],
  }, 'attempt-1');
  assert.match(prepared.markdown, /图片：public（\[原图链接\]\(https:\/\/cdn\.example\.com\/a\.png\)）/);
  assert.match(prepared.markdown, /图片：blob/);
  assert.doesNotMatch(prepared.markdown, /blob:https/);
  assert.doesNotMatch(prepared.markdown, /FEISHU_CLIP_IMAGE/);
  assert.match(prepared.markdown, /剪藏尝试：attempt-1/);
});

test('includeImages keeps raw anchors for media-insert to locate', () => {
  const prepared = prepareMarkdown({
    sourceUrl: 'https://example.com/article',
    capturedAt: '2026-08-12T00:00:00.000Z',
    markdown: '# Heading\n\n[[FEISHU_CLIP_IMAGE:0]]',
    images: [{ label: 'public', source: 'https://cdn.example.com/a.png' }],
  }, 'attempt-1', { includeImages: true });
  assert.match(prepared.markdown, /\[\[FEISHU_CLIP_IMAGE:0\]\]/);
  assert.doesNotMatch(prepared.markdown, /原图链接/);
});
