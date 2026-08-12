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
  assert.match(prepared.markdown, /图片：public/);
  assert.match(prepared.markdown, /\[原图链接：public\]\(https:\/\/cdn\.example\.com\/a\.png\)/);
  assert.match(prepared.markdown, /图片：blob/);
  assert.doesNotMatch(prepared.markdown, /blob:https/);
  assert.match(prepared.markdown, /剪藏尝试：attempt-1/);
});
