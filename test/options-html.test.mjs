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
// chrome.storage.local 的 developerMode 开关（#75 起为第 4 节，前面插入「AI 摘要」）
test('devmode card exists with toggle off and joblog hidden initially', () => {
  assert.match(html, /<h2>5\. 开发者模式<\/h2>/, '应有「5. 开发者模式」卡片');
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
  // 目录行/picker 面板在初始隐藏的 #f-pdf-drive-body 折叠体内（#100 跟进：开关融合小节头部控制展开）
  const pdf = subSection('PDF 保存');
  const body = pdf.match(/<div class="pc-sub-body hidden" id="f-pdf-drive-body">([\s\S]*)/);
  assert.ok(body, 'PDF 保存小节应有初始隐藏的折叠体');
  assert.ok(body[1].includes('id="f-pdf-folder"'), '目录行在折叠体内');
  assert.ok(body[1].includes('id="f-pdf-folder-text"'), '目录行有展示名位');
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

// AI 摘要设置区（#75）：第 2 节，位于「配对」之后、「预设管理」之前（后调整：配置先行，
// 预设里的开关引用它）——API 类型下拉（选项由 options.js 按 AI_API_TYPE_OPTIONS 动态填充）、
// Base URL/Model/API key 输入框、保存 + 测试连接按钮 + 行内结果（初始隐藏）、全局摘要指令 textarea
test('AI 摘要 section sits between pairing and presets with the config form skeleton', () => {
  assert.match(html, /<h2>2\. AI 摘要<\/h2>/, '应有「2. AI 摘要」卡片');
  assert.ok(html.indexOf('<h2>2. AI 摘要</h2>') < html.indexOf('<h2>3. 预设管理</h2>'), 'AI 摘要在预设管理之前');
  assert.ok(html.indexOf('<h2>3. 预设管理</h2>') < html.indexOf('<h2>4. 其他设置</h2>'), '预设管理在其他设置之前');
  assert.ok(html.indexOf('<h2>4. 其他设置</h2>') < html.indexOf('<h2>5. 开发者模式</h2>'), '其他设置在开发者模式之前');
  for (const id of ['ai-api-type', 'ai-base-url', 'ai-model', 'ai-api-key', 'ai-save', 'ai-test', 'ai-instruction']) {
    assert.ok(html.includes(`id="${id}"`), `应有 #${id}`);
  }
  const keyInput = html.match(/<input[^>]*id="ai-api-key"[^>]*>/);
  assert.ok(keyInput[0].includes('type="password"'), 'API key 用密码框');
  assert.ok(classAttr('ai-result').includes('hidden'), '行内结果初始隐藏');
  assert.ok(html.includes('API key 只保存在本机 Bridge'), '应说明 key 不落浏览器存储');
});

// 预设编辑区的 AI 摘要开关（#75）：初始关、预设级指令框初始隐藏（开关开启才显示）
test('preset editor has an AI digest switch, initially off, with a hidden instruction field', () => {
  const row = html.match(/<button[^>]*id="f-digest"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(row, '应有 #f-digest 开关');
  assert.ok(row[0].includes('aria-pressed="false"'), '#f-digest 初始应为关');
  assert.ok(!classAttr('f-digest').includes('on'), '#f-digest 初始不带 on 类');
  assert.ok(classAttr('f-digest-instruction-row').includes('hidden'), '预设级指令框初始隐藏');
  assert.ok(html.includes('id="f-digest-instruction"'), '应有预设级摘要指令输入框');
  assert.ok(html.includes('留空使用全局摘要指令'), '应写明留空 = 用全局指令');
  // provider 选用（#78）：与指令框同排初始隐藏，选项由 options.js 按 bridge 列表动态填充
  assert.ok(classAttr('f-digest-provider-row').includes('hidden'), 'provider 选用行初始隐藏');
  assert.ok(html.includes('id="f-digest-provider"'), '应有 provider 下拉');
  assert.ok(classAttr('f-digest-provider-hint').includes('hidden'), '降级提示初始隐藏（读到列表后不显示）');
});

// 摘要呈现方式（#98）：开关开启才显示的 ps-seg 分段（subdoc 子文档 / inline 内联），
// 以及仅 subdoc 显示的子文档标题模板输入框（placeholder = 默认标题 Digest）
test('preset editor has digest mode segmented control and doc-title field, both initially hidden (#98)', () => {
  assert.ok(classAttr('f-digest-mode-row').includes('hidden'), 'mode 行初始隐藏（随开关开启才显示）');
  const seg = html.match(/<div class="ps-seg" id="f-digest-mode">([\s\S]*?)<\/div>/);
  assert.ok(seg, '应有 #f-digest-mode 分段控件');
  const values = [...seg[1].matchAll(/data-value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ['subdoc', 'inline'], '分段选项为 subdoc 子文档 / inline 内联');
  assert.ok(classAttr('f-digest-doctitle-row').includes('hidden'), '子文档标题行初始隐藏（仅 subdoc 显示）');
  const input = html.match(/<input[^>]*id="f-digest-doctitle"[^>]*>/);
  assert.ok(input, '应有 #f-digest-doctitle 输入框');
  assert.ok(input[0].includes('placeholder="Digest"'), 'placeholder = 默认标题 Digest');
});

// ——— 设置页分区折叠（#76）：第 2/3 区用 details 包裹可折叠，默认展开（open），
// 配对/开发者模式两区不参与；折叠状态持久化逻辑在 options-state.js ———
test('sections 2 (AI 摘要) and 3 (预设管理) are collapsible details, default open', () => {
  for (const [id, title] of [['ai-section-collapse', '2. AI 摘要'], ['presets-section-collapse', '3. 预设管理']]) {
    const block = html.match(new RegExp(`<details[^>]*id="${id}"[^>]*>([\\s\\S]*?)</summary>`));
    assert.ok(block, `应有 #${id} 折叠容器`);
    assert.ok(/<details[^>]*\bopen\b/.test(block[0]), `#${id} 默认展开（open）`);
    assert.ok(block[1].includes(`<h2>${title}</h2>`), `#${id} 的 summary 含区标题「${title}」`);
  }
});

test('other settings is collapsed by default and developer mode stays plain', () => {
  assert.match(html, /<section class="ps-card">\s*<h2>1\. 配对本地 Bridge<\/h2>/, '配对区标题不被 details 包裹');
  assert.match(html, /<details class="ps-collapse" id="other-section-collapse">\s*<summary[^>]*><h2>4\. 其他设置<\/h2>/, '其他设置默认折叠');
  for (const id of ['proxy-port', 'proxy-save', 'proxy-result']) assert.ok(html.includes(`id="${id}"`), `应有 #${id}`);
  assert.match(html, /<section class="ps-card">\s*<h2>5\. 开发者模式<\/h2>/, '开发者模式区标题不被 details 包裹');
});

// AI provider 预设管理（#77）：AI 摘要区从单表单升级为 tabs + 名称/删除的提供者管理骨架；
// 原有字段 id 全部保留（options.js 复用），全局摘要指令不动
test('AI 摘要 section has provider tabs, name field, delete button; config fields unchanged', () => {
  for (const id of ['ai-provider-tabs', 'ai-name', 'ai-delete', 'ai-api-type', 'ai-base-url', 'ai-model', 'ai-api-key', 'ai-save', 'ai-test', 'ai-instruction', 'ai-headers', 'ai-max-output-tokens', 'ai-timeout']) {
    assert.ok(html.includes(`id="${id}"`), `应有 #${id}`);
  }
  assert.match(html, /<div class="ps-tabs" id="ai-provider-tabs"><\/div>/, 'provider tabs 容器初始为空（由 options.js 渲染）');
});

// {{@file}} 快捷插入（#81）：两个摘要指令框（全局 #ai-instruction / 预设级 #f-digest-instruction）
// 各有专属变量行，data-vars="@file"——只列附件占位符，不混用标题/正文模板变量（指令里不会被替换）；
// 按钮由 options.js 复用 insertVariable 路径渲染，点击在光标处插入
test('both digest instruction fields have a {{@file}} quick-insert row and explanation (#81)', () => {
  for (const field of ['ai-instruction', 'f-digest-instruction']) {
    const row = html.match(new RegExp(`class="ps-vars" data-field="${field}" data-vars="([^"]*)"`));
    assert.ok(row, `#${field} 应有变量快捷插入行（.ps-vars）`);
    assert.equal(row[1], '@file', `#${field} 的变量行只列 @file`);
  }
  assert.ok(html.includes('检出 PDF 时随请求一并发给 AI'), '应说明 {{@file}} 语义');
  assert.ok(html.includes('无 PDF 时降级为纯文本摘要'), '应说明无 PDF 时降级');
});

// {{@file}} 行内提示（#81）：预设级指令含 {{@file}} 但预设未开「PDF 存云盘」时在指令框旁提示
// （显隐由 options.js 按 digestFileHintNeeded 控制），初始隐藏
test('preset instruction has an initially-hidden {{@file}}-without-pdfDrive hint (#81)', () => {
  assert.ok(classAttr('f-digest-file-hint').includes('hidden'), '#f-digest-file-hint 初始应隐藏');
  const hint = html.match(/<[^>]*id="f-digest-file-hint"[^>]*>([\s\S]*?)<\/[^>]+>/);
  assert.ok(hint[1].includes('PDF 存云盘'), '提示应指向「PDF 存云盘」开关');
});

// reasoning 三态开关（#96）：与 headers/maxOutputTokens/timeoutMs 并列在「高级设置」折叠区，
// 三态下拉（默认 = 跟随服务端 / 开 / 关），默认 option 的 value 为空串（aiConfigPayload 据此不进 body）
test('AI 高级设置含 reasoning 三态下拉（默认/开/关）（#96）', () => {
  const select = html.match(/<select id="ai-reasoning"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, '应有 #ai-reasoning 下拉');
  const values = [...select[1].matchAll(/<option value="([^"]*)">/g)].map((match) => match[1]);
  assert.deepEqual(values, ['', 'on', 'off'], '三态顺序：默认（跟随服务端）/ 开 / 关');
  const advanced = html.match(/<details class="ps-advanced">([\s\S]*?)<\/details>/);
  assert.ok(advanced[1].includes('id="ai-reasoning"'), 'reasoning 下拉在高级设置折叠区内');
});

// ——— 预设编辑器三小节（#100）：基本信息 / PDF 保存 / AI 摘要；PDF 保存与 AI 摘要由各自开关
// 控制小节折叠（打开才展示对应设置），字体层级 区大标题 > 小节标题 > 正文/控件 ———

function subSection(title) {
  const match = html.match(new RegExp(`<section class="pc-sub">\\s*(?:<div class="pc-sub-head">\\s*)?<h3 class="pc-sub-title">${title}</h3>([\\s\\S]*?)</section>`));
  assert.ok(match, `应有「${title}」小节（section.pc-sub，可选 .pc-sub-head > h3.pc-sub-title）`);
  return match[1];
}

// 小节头部融合（#100 跟进）：标题与开关同一行，开关直接控制 .pc-sub-body 的展开/折叠
function subHead(title) {
  const match = html.match(new RegExp(`<section class="pc-sub">\\s*<div class="pc-sub-head">\\s*<h3 class="pc-sub-title">${title}</h3>([\\s\\S]*?)</div>`));
  assert.ok(match, `「${title}」小节应有 .pc-sub-head 头部行`);
  return match[1];
}

test('preset editor is split into three titled subsections in fixed order (#100)', () => {
  const titles = ['基本信息', 'PDF 保存', 'AI 摘要'];
  let lastIndex = -1;
  for (const title of titles) {
    const index = html.indexOf(`<h3 class="pc-sub-title">${title}</h3>`);
    assert.ok(index > lastIndex, `小节「${title}」应存在且按顺序出现`);
    lastIndex = index;
  }
});

test('基本信息小节含名称/保存目标/图片模式/标题模板/正文模板/默认动作/触发规则 (#100)', () => {
  const basic = subSection('基本信息');
  for (const id of ['f-name', 'f-target', 'picker-panel', 'f-image-mode', 'f-title', 'f-body', 'f-action', 'f-triggers']) {
    assert.ok(basic.includes(`id="${id}"`), `基本信息小节应含 #${id}`);
  }
});

test('PDF 保存小节：开关融入头部行，body 初始隐藏（开关折叠语义）(#100)', () => {
  const head = subHead('PDF 保存');
  assert.ok(head.includes('id="f-pdf-drive"'), '开关应在小节头部行内');
  const pdf = subSection('PDF 保存');
  const body = pdf.match(/<div class="pc-sub-body hidden" id="f-pdf-drive-body">([\s\S]*)/);
  assert.ok(body, '应有初始隐藏的 #f-pdf-drive-body');
  for (const id of ['f-pdf-folder', 'drive-picker-panel']) {
    assert.ok(body[1].includes(`id="${id}"`), `折叠 body 应含 #${id}`);
  }
  assert.ok(!pdf.includes('id="f-digest"'), 'AI 摘要不属于本小节');
});

test('AI 摘要小节：开关融入头部行，body 初始隐藏（开关折叠语义）(#100)', () => {
  const head = subHead('AI 摘要');
  assert.ok(head.includes('id="f-digest"'), '开关应在小节头部行内');
  const ai = subSection('AI 摘要');
  const body = ai.match(/<div class="pc-sub-body hidden" id="f-digest-body">([\s\S]*)/);
  assert.ok(body, '应有初始隐藏的 #f-digest-body');
  for (const id of ['f-digest-provider-row', 'f-digest-mode-row', 'f-digest-doctitle-row', 'f-digest-instruction-row']) {
    assert.ok(body[1].includes(`id="${id}"`), `折叠 body 应含 #${id}`);
  }
  assert.ok(!ai.includes('id="f-triggers"'), '触发规则不属于本小节');
});

const css = await readFile(new URL('../src/extension/ui.css', import.meta.url), 'utf8');

function fontSizeOf(selector) {
  const match = css.match(new RegExp(`\\.options ${selector.replace(/\./g, '\\.')}\\{[^}]*?font-size:([\\d.]+)px`));
  assert.ok(match, `ui.css 应有 .options ${selector} 的 font-size 规则`);
  return Number(match[1]);
}

test('字体层级统一：区大标题 > 小节标题 > 正文控件；开关不再带文字 (#100)', () => {
  const h2 = fontSizeOf('.ps-card h2');
  const sub = fontSizeOf('.pc-sub-title');
  const label = fontSizeOf('.pc-form .ps-label');
  assert.ok(h2 > sub, `区大标题(${h2}) 应大于小节标题(${sub})`);
  assert.ok(sub > label, `小节标题(${sub}) 应大于字段标签(${label})`);
  const form = html.match(/<div class="pc-form">([\s\S]*?)<\/div>\s*<\/details>/);
  assert.ok(form, '应能截取 pc-form 区域');
  assert.ok(!form[1].includes('ps-switch-label'), 'pc-form 内不应再有偏大的开关文字（已并入小节标题/描述）');
});

// 规则预设控件字号（#101 跟进）：保存按钮/内联表单的保存与取消全部归入正文档（与字段标签一致），
// 不得吃 .ps-btn(13px)/.link(继承 14px) 的默认档
test('规则预设区按钮字号与字段标签一致 (#101)', () => {
  const label = fontSizeOf('.pc-form .ps-label');
  for (const selector of ['.trigger-save-btn', '.trigger-save-form .ps-btn', '.trigger-save-form .link']) {
    assert.equal(fontSizeOf(selector), label, `${selector} 应为 ${label}px（正文档）`);
  }
});

// ——— 触发规则预设气泡（#101）：气泡在输入框上方；名称+规则两字段；保存为新预设按钮 + 内联名称表单 ———

test('触发规则预设气泡区位于 triggers 输入框上方，含保存按钮与内联名称表单 (#101)', () => {
  const bar = html.indexOf('id="trigger-presets"');
  const field = html.indexOf('id="f-triggers"');
  assert.ok(bar > -1 && field > -1 && bar < field, '气泡区 #trigger-presets 应在 #f-triggers 上方');
  assert.ok(html.includes('id="trigger-preset-save"'), '应有「保存为新预设」按钮');
  const formMatch = html.match(/<div[^>]*id="trigger-preset-form"[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/div>/)
    ?? html.match(/<div[^>]*class="([^"]*)"[^>]*id="trigger-preset-form"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(formMatch, '应有内联名称表单 #trigger-preset-form');
  assert.ok(formMatch[1].includes('hidden'), '名称表单初始隐藏');
  assert.ok(formMatch[2].includes('id="trigger-preset-name"'), '表单含名称输入框');
  assert.ok(formMatch[2].includes('id="trigger-preset-confirm"'), '表单含确认按钮');
  assert.ok(formMatch[2].includes('id="trigger-preset-cancel"'), '表单含取消按钮');
});
