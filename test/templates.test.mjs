import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContext, renderBody, renderTemplate, renderTitle, sanitizeFilename } from '../src/extension/templates.js';

// 用本地时间分量构造，避免时区影响断言
const capturedAt = new Date(2026, 0, 5, 9, 7, 3).toISOString(); // 2026-01-05 09:07:03 本地
const snapshot = {
  title: '一篇 文章/标题',
  sourceUrl: 'https://blog.example.com/posts/42?x=1',
  capturedAt,
  markdown: '# 正文\n\n内容',
  images: [],
};
const ctx = buildContext(snapshot);

test('buildContext derives all v1 variables from a snapshot', () => {
  assert.equal(ctx.title, snapshot.title);
  assert.equal(ctx.url, snapshot.sourceUrl);
  assert.equal(ctx.host, 'blog.example.com');
  assert.equal(ctx.date, '2026-01-05');
  assert.equal(ctx.time, '09:07');
  assert.equal(ctx.datetime, '2026-01-05 09:07');
  assert.equal(ctx.content, snapshot.markdown);
});

test('buildContext tolerates an unparseable url and capturedAt', () => {
  const broken = buildContext({ title: 't', sourceUrl: 'not a url', capturedAt: 'garbage', markdown: 'm', images: [] });
  assert.equal(broken.host, '');
  assert.equal(broken.date, '');
  assert.equal(broken.time, '');
  assert.equal(broken.datetime, '');
});

test('renderTemplate substitutes known variables and blanks unknown ones', () => {
  assert.equal(renderTemplate('{{title}} @ {{host}}', ctx), `${snapshot.title} @ blog.example.com`);
  assert.equal(renderTemplate('{{ title }}', ctx), snapshot.title, 'placeholder 允许空白');
  assert.equal(renderTemplate('{{unknown}}', ctx), '');
  assert.equal(renderTemplate('a {{unknown}} b', ctx), 'a  b');
});

test('renderTemplate applies the date filter with YYYY MM DD HH mm ss tokens', () => {
  assert.equal(renderTemplate('{{date|date:YYYYMMDD}}', ctx), '20260105');
  assert.equal(renderTemplate('{{time|date:HH-mm-ss}}', ctx), '09-07-03');
  assert.equal(renderTemplate('{{datetime|date:YYYY年MM月DD日 HH:mm}}', ctx), '2026年01月05日 09:07');
  assert.equal(renderTemplate('{{date | date:YYYY/MM/DD}}', ctx), '2026/01/05', 'filter 两侧允许空白');
});

test('renderTemplate blanks illegal filter usage like unknown variables', () => {
  assert.equal(renderTemplate('{{title|date:YYYY}}', ctx), '', '非时间变量接 filter');
  assert.equal(renderTemplate('{{url|date:YYYY}}', ctx), '');
  assert.equal(renderTemplate('{{date|upper}}', ctx), '', '不认识的 filter 名');
  assert.equal(renderTemplate('{{date|date}}', ctx), '', '缺 FORMAT');
  assert.equal(renderTemplate('{{unknown|date:YYYY}}', ctx), '', '未知变量接 filter');
});

test('renderBody replaces the {{content}} placeholder when present', () => {
  const out = renderBody('> 来源：{{url}}\n\n{{content}}\n\n—— {{date}}', ctx);
  assert.equal(out, `> 来源：${snapshot.sourceUrl}\n\n${snapshot.markdown}\n\n—— 2026-01-05`);
  assert.equal(renderBody('{{ content }}', ctx), snapshot.markdown, '占位符允许空白');
});

test('renderBody appends a placeholder-free template after the content', () => {
  const out = renderBody('---\n{{date}}', ctx);
  assert.equal(out, `${snapshot.markdown}\n\n---\n2026-01-05`);
});

test('renderBody returns the content unchanged for an empty or blank template', () => {
  assert.equal(renderBody('', ctx), snapshot.markdown);
  assert.equal(renderBody('   \n  ', ctx), snapshot.markdown);
});

test('renderTitle falls back to ctx.title when the render is empty or blank', () => {
  assert.equal(renderTitle('{{unknown}}', ctx), sanitizeFilename(snapshot.title));
  assert.equal(renderTitle('   ', ctx), sanitizeFilename(snapshot.title));
  assert.equal(renderTitle('', ctx), sanitizeFilename(snapshot.title));
});

test('renderTitle renders and sanitizes the result', () => {
  assert.equal(renderTitle('{{title}} - {{host}}', ctx), '一篇 文章-标题 - blog.example.com');
  assert.equal(renderTitle('[{{date|date:YYYY-MM-DD}}] {{title}}', ctx), '[2026-01-05] 一篇 文章-标题');
});

test('sanitizeFilename strips unsafe characters, trims and drops trailing dots', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(sanitizeFilename('a\u0001b\u001f'), 'a-b-', '控制字符替换为 -');
  assert.equal(sanitizeFilename('  名称..  '), '名称');
  assert.equal(sanitizeFilename('...'), '');
});
