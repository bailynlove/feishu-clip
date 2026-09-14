// popup.html 的 PDF 存云盘标记与 popup.js 动态控制的契约（#65）：
// #pdf-row（折叠区内开关）/#pdf-discover（识别到主 PDF 的虚线入口）/#open-pdf/#retry-pdf
// 都由 popup.js 的 syncPdfView/showJob 用 hidden 类管理，初始必须 hidden——
// 未识别到主 PDF 的普通页面不应出现任何 PDF 入口。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/extension/popup.html', import.meta.url), 'utf8');

function classAttr(id) {
  const match = html.match(new RegExp(`id="${id}"[^>]*class="([^"]*)"`)) ?? html.match(new RegExp(`class="([^"]*)"[^>]*id="${id}"`));
  assert.ok(match, `popup.html 应包含 #${id}`);
  return match[1].split(/\s+/);
}

test('PDF entries start hidden and are managed by popup.js', () => {
  for (const id of ['pdf-row', 'pdf-discover', 'open-pdf', 'retry-pdf', 'pdf-temp-badge', 'pdf-folder', 'drive-picker-panel']) {
    assert.ok(classAttr(id).includes('hidden'), `#${id} 初始应为 hidden`);
  }
});

// 目录 chip（#66）：PDF 开关开启后显示「🗂 目录名 + 更改 ›」，打开 drive picker overlay
test('pdf folder chip and drive picker overlay (#66)', () => {
  const chip = html.match(/<button id="pdf-folder"[\s\S]*?<\/button>/);
  assert.ok(chip, '折叠区内应有 #pdf-folder 目录 chip');
  assert.ok(chip[0].includes('id="pdf-folder-name"'), 'chip 有目录名位');
  assert.ok(chip[0].includes('id="pdf-folder-temp-badge"'), 'chip 有「仅本次」徽标位');
  assert.ok(chip[0].includes('更改 ›'), 'chip 有更改入口');

  const overlay = html.match(/<div id="drive-picker-panel"[\s\S]*?<\/section><\/div>/);
  assert.ok(overlay, '应有 drive picker overlay（与目标 picker 同一形态）');
  for (const id of ['dp-crumbs', 'dp-status', 'dp-list', 'dp-more', 'dp-back', 'dp-retry', 'dp-cancel', 'dp-confirm', 'drive-picker-mask']) {
    assert.ok(overlay[0].includes(`id="${id}"`), `overlay 应有 #${id}`);
  }
  assert.ok(overlay[0].includes('仅本次'), 'overlay 标明仅本次生效');
});

test('pdf-row carries the switch, subtitle slot and session-only badge', () => {
  const row = html.match(/<label id="pdf-row"[\s\S]*?<\/label>/);
  assert.ok(row, '折叠区内应有 #pdf-row 开关行');
  assert.ok(row[0].includes('id="pdf-sub"'), '应有副标题位（显示识别到的 PDF 名与大小）');
  assert.ok(row[0].includes('id="pdf"'), '应有开关 checkbox');
  assert.ok(row[0].includes('id="pdf-temp-badge"'), '应有「仅本次」徽标位');
});

test('CTA 区有并排的「打开飞书文档 / 打开云盘 PDF」与 ghost 重试按钮', () => {
  const links = html.match(/<div class="cta-links">[\s\S]*?<\/div>/);
  assert.ok(links, '应有 .cta-links 并排容器');
  assert.ok(links[0].includes('id="open"') && links[0].includes('id="open-pdf"'), '文档与 PDF 链接并排');
  assert.ok(html.includes('id="retry-pdf"'), 'PDF 失败时提供重试入口');
});

// PDF 标签页单面板（#67）：#pdf-tab-panel 初始 hidden，由 popup.js 在探针命中后整体切换；
// #web-panel 包住全部网页剪藏 UI（预设 chips/折叠区/CTA），pdf-tab 形态下整体隐藏
test('pdf-tab panel starts hidden with name/size/folder/save slots and the pdf-only note (#67)', () => {
  assert.ok(classAttr('pdf-tab-panel').includes('hidden'), '#pdf-tab-panel 初始应为 hidden');
  const panel = html.match(/<section id="pdf-tab-panel"[\s\S]*?<\/section>/);
  assert.ok(panel, '应有 #pdf-tab-panel 单面板');
  for (const id of ['pdf-tab-name', 'pdf-tab-meta', 'pdf-tab-folder', 'pdf-tab-folder-name', 'pdf-tab-save']) {
    assert.ok(panel[0].includes(`id="${id}"`), `面板应有 #${id}`);
  }
  assert.ok(panel[0].includes('📕'), '面板有 PDF 图标');
  assert.ok(panel[0].includes('⬇ 保存 PDF 到云盘'), '主按钮初始为保存');
  assert.ok(panel[0].includes('仅上传云盘，不创建剪藏文档'), '面板注明不创建剪藏文档');
});

// 临时 AI 摘要子卡（#84，变体 B「开关即折叠」）：头部即开关行 + 副标题位；内容区初始
// 折叠（hidden），provider chips 由 popup.js 按 bridge 列表动态填充，两个提示位初始 hidden
test('digest fold carries the head switch row and collapsed body slots (#84)', () => {
  const fold = html.match(/<section id="digest-fold"[\s\S]*?<\/section>/);
  assert.ok(fold, '本次设置卡内应有 #digest-fold 子卡');
  assert.ok(fold[0].includes('ai-fold'), '子卡带 ai-fold 虚线边样式类');
  assert.ok(fold[0].includes('id="digest-on"'), '头部应有开关 checkbox');
  assert.ok(fold[0].includes('id="digest-sub"'), '头部应有跟随/本次副标题位');
  assert.ok(!fold[0].includes('chip-temp'), '设计定稿：无「仅本次」徽标');
  assert.ok(classAttr('digest-body').includes('hidden'), '#digest-body 初始折叠');
  for (const id of ['digest-seg', 'digest-empty', 'digest-provider-hint', 'digest-instruction']) {
    assert.ok(fold[0].includes(`id="${id}"`), `内容区应有 #${id}`);
  }
  assert.ok(classAttr('digest-empty').includes('hidden'), '#digest-empty 初始 hidden');
  assert.ok(classAttr('digest-provider-hint').includes('hidden'), '#digest-provider-hint 初始 hidden');
  assert.ok(fold[0].includes('{{@file}}'), '指令框 placeholder 提示 {{@file}} 可附 PDF');
});

test('web clip UI is wrapped in #web-panel so pdf-tab mode can hide it wholesale', () => {
  const wrap = html.match(/<div id="web-panel">[\s\S]*?<\/div>\s*<section id="pdf-tab-panel"/);
  assert.ok(wrap, '#web-panel 应包住网页剪藏 UI 并紧邻 #pdf-tab-panel');
  for (const id of ['presets', 'settings-toggle', 'preview-toggle', 'save', 'pdf-row', 'pdf-discover']) {
    assert.ok(wrap[0].includes(`id="${id}"`), `#web-panel 应包含 #${id}`);
  }
  const statusIndex = html.indexOf('id="status"');
  const wrapIndex = html.indexOf('id="web-panel"');
  assert.ok(statusIndex !== -1 && statusIndex < wrapIndex, '#status 在两种形态间共用，须在 #web-panel 之外');
});
