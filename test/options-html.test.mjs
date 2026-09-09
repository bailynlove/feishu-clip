// options.html 静态标记与 picker-view.js 动态控制的契约（#35 bug 回归）：
// renderPicker 只用 disabled/textContent 管理 els.save，从不移除 hidden 类——
// 所以 #picker-save 的静态 class 不得带 hidden，否则真实浏览器里保存按钮永远 display:none
// （linkedom/无障碍树之外的盲区：picker 选了目标也点不到保存）。more/back/retry 相反，
// renderPicker 会 toggle 它们的 hidden，初始 hidden 是正确的。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/extension/options.html', import.meta.url), 'utf8');

function classAttr(id) {
  const match = html.match(new RegExp(`id="${id}"[^>]*class="([^"]*)"`)) ?? html.match(new RegExp(`class="([^"]*)"[^>]*id="${id}"`));
  assert.ok(match, `options.html 应包含 #${id}`);
  return match[1].split(/\s+/);
}

test('picker-save is not statically hidden (renderPicker manages it via disabled only)', () => {
  assert.ok(!classAttr('picker-save').includes('hidden'), '#picker-save 不得带 hidden 类');
});

test('picker-more/back/retry start hidden (renderPicker toggles them)', () => {
  for (const id of ['picker-more', 'picker-back', 'picker-retry']) {
    assert.ok(classAttr(id).includes('hidden'), `#${id} 初始应为 hidden`);
  }
});

// 开发者模式卡片（任务耗时日志）：开关初始关、日志区初始隐藏，由 options.js 按
// chrome.storage.local 的 developerMode 开关
test('devmode card exists with toggle off and joblog hidden initially', () => {
  assert.match(html, /<h2>3\. 开发者模式<\/h2>/, '应有「3. 开发者模式」卡片');
  assert.ok(!classAttr('devmode-toggle').includes('on'), '#devmode-toggle 初始应为关');
  assert.ok(classAttr('joblog').includes('hidden'), '#joblog 初始应隐藏');
  assert.ok(html.includes('id="joblog-refresh"'), '应有刷新按钮');
  assert.ok(html.includes('id="joblog-list"'), '应有任务列表容器');
});

// 图片写入模式三态（#53）：预设编辑区用分段控件取代旧的「包含图片」开关
test('preset editor has a three-state image mode segmented control', () => {
  const seg = html.match(/<div class="ps-seg" id="f-image-mode">([\s\S]*?)<\/div>/);
  assert.ok(seg, '应有 #f-image-mode 分段控件');
  const values = [...seg[1].matchAll(/class="ps-seg-opt" data-value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ['preview', 'download', 'off'], '三态顺序：预览优先/下载优先/不保存');
  for (const label of ['预览优先', '下载优先', '不保存']) assert.ok(seg[1].includes(label), `缺少选项「${label}」`);
  assert.ok(html.includes('id="f-image-mode-hint"'), '应有模式说明文案位');
  assert.ok(!html.includes('id="f-images"'), '旧的「包含图片」开关应移除');
});

// PDF 存云盘预设开关（#65）：预设表单提供「识别到论文主 PDF 时顺带存入云盘」开关，
// 初始关；本切片目录固定云盘根目录（picker 归 #66），文案须写明根目录
test('preset editor has a PDF-drive switch, initially off', () => {
  const row = html.match(/<button[^>]*id="f-pdf-drive"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(row, '应有 #f-pdf-drive 开关');
  assert.ok(row[0].includes('aria-pressed="false"'), '#f-pdf-drive 初始应为关');
  assert.ok(!classAttr('f-pdf-drive').includes('on'), '#f-pdf-drive 初始不带 on 类');
  assert.ok(row[1].includes('云盘根目录'), '说明文案应写明本切片固定存云盘根目录');
});
