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

// PDF 存云盘预设开关（#65）+ 目录选择（#66）：开关初始关；开启后显示目录行（picker 面板 +
// 高级设置手贴 token），picker 面板控件与 renderDrivePicker 的 hidden 管理契约同 wiki 面板
test('preset editor has a PDF-drive switch, initially off', () => {
  const row = html.match(/<button[^>]*id="f-pdf-drive"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(row, '应有 #f-pdf-drive 开关');
  assert.ok(row[0].includes('aria-pressed="false"'), '#f-pdf-drive 初始应为关');
  assert.ok(!classAttr('f-pdf-drive').includes('on'), '#f-pdf-drive 初始不带 on 类');
});

test('preset editor has a PDF folder row and drive picker panel (#66)', () => {
  assert.ok(classAttr('f-pdf-folder').includes('hidden'), '目录行初始隐藏（开关默认关）');
  assert.ok(html.includes('id="f-pdf-folder-text"'), '目录行有展示名位');
  assert.ok(classAttr('drive-picker-panel').includes('hidden'), 'drive picker 面板初始隐藏');
  for (const id of ['dp-crumbs', 'dp-status', 'dp-list']) assert.ok(html.includes(`id="${id}"`), `应有 #${id}`);
  for (const id of ['dp-more', 'dp-back', 'dp-retry']) {
    assert.ok(classAttr(id).includes('hidden'), `#${id} 初始应为 hidden`);
  }
  assert.ok(!classAttr('dp-save').includes('hidden'), '#dp-save 不得带 hidden 类（renderDrivePicker 用 disabled 管理）');
  // 高级设置：手贴 token 路径
  const advanced = html.match(/<details id="drive-advanced">([\s\S]*?)<\/details>/);
  assert.ok(advanced, '应有手贴 token 的高级设置');
  assert.ok(advanced[1].includes('id="drive-token"'), '应有目录 token 输入框');
  assert.ok(advanced[1].includes('留空表示云盘根目录'), '应写明留空即根目录');
  assert.ok(advanced[1].includes('id="save-drive-target"'), '应有验证并保存按钮');
});
