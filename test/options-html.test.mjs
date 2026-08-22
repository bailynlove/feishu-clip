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
