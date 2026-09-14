import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultPreset } from '../src/extension/presets.js';
import {
  addPreset, duplicatePreset, movePreset, removePreset, renamePreset, setDefaultPreset, updatePreset,
  validateTriggers, parseTriggers, insertVariable, TEMPLATE_VARIABLES,
  variableRowNames, digestFileHintNeeded,
  jobStatusTone, jobStatusLabel, formatDuration, jobTotalLabel, formatClock, jobDisplayTitle, jobDetailRows,
  IMAGE_MODE_OPTIONS, imageModeHint,
} from '../src/extension/options-state.js';

function makeState(count = 3) {
  const presets = Array.from({ length: count }, (_, index) => createDefaultPreset({ name: `预设${index + 1}` }));
  return { presets, defaultPresetId: presets[0].id };
}

// ——— 列表操作 ———

test('addPreset appends a new preset without changing the default', () => {
  const state = makeState(1);
  const next = addPreset(state);
  assert.equal(next.presets.length, 2);
  assert.equal(next.presets[1].name, '预设 2');
  assert.notEqual(next.presets[1].id, next.presets[0].id);
  assert.equal(next.defaultPresetId, state.defaultPresetId);
  assert.equal(state.presets.length, 1, '不改原 state');
});

test('renamePreset updates the name in place', () => {
  const state = makeState();
  const next = renamePreset(state, state.presets[1].id, '技术文章');
  assert.equal(next.presets[1].name, '技术文章');
  assert.equal(next.presets[0].name, '预设1');
});

test('duplicatePreset copies fields with a new id and inserts after the source', () => {
  const state = makeState(2);
  state.presets[0].triggers = ['https://a.com/'];
  state.presets[0].destination = { kind: 'space', spaceId: 's1' };
  const next = duplicatePreset(state, state.presets[0].id);

  assert.equal(next.presets.length, 3);
  const copy = next.presets[1];
  assert.equal(copy.name, '预设1 副本');
  assert.notEqual(copy.id, state.presets[0].id);
  assert.deepEqual(copy.destination, state.presets[0].destination);
  assert.deepEqual(copy.triggers, ['https://a.com/']);
  assert.equal(next.presets[2].id, state.presets[1].id, '原第二套顺延');
});

test('removePreset refuses to remove the last preset', () => {
  const state = makeState(1);
  assert.equal(removePreset(state, state.presets[0].id), null, '至少保留一套');
});

test('removePreset shifts the default to the first remaining preset when the default is removed', () => {
  const state = makeState(3);
  const next = removePreset(state, state.presets[0].id);
  assert.equal(next.presets.length, 2);
  assert.equal(next.defaultPresetId, next.presets[0].id, '删默认顺延列表第一套');
  assert.equal(next.defaultPresetId, state.presets[1].id);
});

test('removePreset keeps the default when a non-default preset is removed', () => {
  const state = makeState(3);
  const next = removePreset(state, state.presets[2].id);
  assert.equal(next.defaultPresetId, state.presets[0].id);
});

test('movePreset reorders and clamps at both ends', () => {
  const state = makeState(3);
  const [a, b, c] = state.presets.map((preset) => preset.id);

  const down = movePreset(state, a, +1);
  assert.deepEqual(down.presets.map((preset) => preset.id), [b, a, c]);

  const up = movePreset(state, c, -1);
  assert.deepEqual(up.presets.map((preset) => preset.id), [a, c, b]);

  assert.deepEqual(movePreset(state, a, -1).presets.map((preset) => preset.id), [a, b, c], '顶部不上移');
  assert.deepEqual(movePreset(state, c, +1).presets.map((preset) => preset.id), [a, b, c], '底部不下移');
});

test('setDefaultPreset switches the default and ignores unknown ids', () => {
  const state = makeState(2);
  const next = setDefaultPreset(state, state.presets[1].id);
  assert.equal(next.defaultPresetId, state.presets[1].id);
  assert.equal(setDefaultPreset(state, 'nope'), state);
});

test('updatePreset patches a preset immutably', () => {
  const state = makeState(1);
  const next = updatePreset(state, state.presets[0].id, { imageMode: 'off', action: 'file' });
  assert.equal(next.presets[0].imageMode, 'off');
  assert.equal(next.presets[0].action, 'file');
  assert.equal(state.presets[0].imageMode, 'preview', '不改原 state');
  assert.equal(updatePreset(state, 'nope', { name: 'x' }), state);
});

// ——— 图片写入模式（#53）：设置页三态选项与说明文案 ———

test('IMAGE_MODE_OPTIONS lists the three modes in preview/download/off order', () => {
  assert.deepEqual(IMAGE_MODE_OPTIONS.map((option) => option.value), ['preview', 'download', 'off']);
  assert.deepEqual(IMAGE_MODE_OPTIONS.map((option) => option.label), ['预览优先', '下载优先', '不保存']);
});

test('image mode hints spell out the 依赖原站 / 较慢 / 不保存 tradeoffs', () => {
  assert.match(imageModeHint('preview'), /原站/, '预览优先要说明依赖原站可持续访问');
  assert.match(imageModeHint('download'), /较慢/, '下载优先要说明较慢');
  assert.match(imageModeHint('off'), /不保存/, '不保存要说明不处理图片');
  assert.equal(imageModeHint('bogus'), imageModeHint('preview'), '未知模式回退到默认（预览优先）说明');
});

// ——— triggers 校验（#32）———

test('validateTriggers accepts http/https prefixes and regex rules', () => {
  const text = [
    'https://example.com/blog',
    'http://a.b/c?d=e',
    '/^https:\\/\\/.*\\.zhihu\\.com\\//',
    '/foo|bar/i',
    '',
    '   ',
  ].join('\n');
  assert.deepEqual(validateTriggers(text), []);
});

test('validateTriggers flags prefixes not starting with http(s)://', () => {
  const errors = validateTriggers('example.com/blog\nftp://x.com/\nhttps://ok.com/');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 1);
  assert.equal(errors[0].reason, '前缀须以 http(s):// 开头');
  assert.equal(errors[0].text, 'example.com/blog');
  assert.equal(errors[1].line, 2, '提示行号');
});

test('validateTriggers flags invalid regex rules with line numbers', () => {
  const errors = validateTriggers('https://ok.com/\n/(/\n/abc/g\n/unclosed');
  assert.equal(errors.length, 3);
  assert.deepEqual(
    errors.map((error) => error.line),
    [2, 3, 4],
  );
  assert.equal(errors[0].reason, '正则表达式非法');
  assert.equal(errors[1].reason, '正则只支持 i 标志');
  assert.equal(errors[2].reason, '正则须写成 /pattern/ 形式');
});

test('parseTriggers trims lines and drops blanks', () => {
  assert.deepEqual(parseTriggers('  https://a.com/ \n\n/x/\n'), ['https://a.com/', '/x/']);
  assert.deepEqual(parseTriggers(''), []);
});

// ——— 变量快捷插入 ———

test('insertVariable inserts {{name}} at the cursor and reports the new cursor', () => {
  const result = insertVariable('标题-{{title}}', 3, 'url');
  assert.equal(result.text, '标题-{{url}}{{title}}');
  assert.equal(result.cursor, 3 + '{{url}}'.length);

  const atEnd = insertVariable('abc', 3, 'content');
  assert.equal(atEnd.text, 'abc{{content}}');

  const defaulted = insertVariable('abc', undefined, 'host');
  assert.equal(defaulted.text, '{{host}}abc', '非数字 cursor 回落到 0');

  const clamped = insertVariable('abc', 99, 'date');
  assert.equal(clamped.text, 'abc{{date}}');
});

test('TEMPLATE_VARIABLES covers the v1 variable set (#30) plus digest (#75)', () => {
  assert.deepEqual(TEMPLATE_VARIABLES, ['title', 'url', 'host', 'date', 'time', 'datetime', 'content', 'digest']);
});

// {{@file}} 附件占位符（#81）：摘要指令框的变量行只列 @file——标题/正文模板变量在指令里
// 不会被替换，不能混进指令框的快捷插入按钮
test('variableRowNames defaults to TEMPLATE_VARIABLES and honors an explicit data-vars list', () => {
  assert.deepEqual(variableRowNames(undefined), TEMPLATE_VARIABLES, '无 data-vars 用默认模板变量集');
  assert.deepEqual(variableRowNames(''), TEMPLATE_VARIABLES, '空 data-vars 同样回落默认集');
  assert.deepEqual(variableRowNames('@file'), ['@file'], '指令框只列 @file');
  assert.deepEqual(variableRowNames('@file, digest'), ['@file', 'digest'], '逗号/空格分隔多项');
});

// {{@file}} 行内提示（#81）：预设级指令含 {{@file}} 但该预设未开「PDF 存云盘」时提示；
// 只提示不阻止保存（全局指令场景无法静态判定）
test('digestFileHintNeeded flags {{@file}} instructions on presets without pdfDrive', () => {
  assert.equal(digestFileHintNeeded('总结要点，参考附件 {{@file}}', false), true);
  assert.equal(digestFileHintNeeded('总结要点，参考附件 {{ @file }}', false), true, '空格写法同样检出（与 bridge 端口径一致）');
  assert.equal(digestFileHintNeeded('总结要点，参考附件 {{@file}}', true), false, '开了「PDF 存云盘」不提示');
  assert.equal(digestFileHintNeeded('总结要点', false), false, '无 {{@file}} 不提示');
  assert.equal(digestFileHintNeeded('', false), false, '空指令（用全局）不提示');
  assert.equal(digestFileHintNeeded(null, false), false, '非字符串归一为不提示');
});

// ——— 开发者模式：任务耗时日志展示逻辑 ———

test('jobStatusTone buckets statuses into success/warning/error/running', () => {
  assert.equal(jobStatusTone('succeeded'), 'success');
  assert.equal(jobStatusTone('succeeded_with_warnings'), 'warning');
  assert.equal(jobStatusTone('cancelled'), 'warning', '用户主动取消不算失败');
  assert.equal(jobStatusTone('cancelled_with_document'), 'warning');
  assert.equal(jobStatusTone('failed'), 'error');
  assert.equal(jobStatusTone('needs_attention'), 'error');
  assert.equal(jobStatusTone('expired'), 'error');
  assert.equal(jobStatusTone('queued'), 'running');
  assert.equal(jobStatusTone('running'), 'running');
  assert.equal(jobStatusTone('something-new'), 'error', '未知状态按失败兜底，避免静默漏报');
});

test('jobStatusLabel gives Chinese labels for known statuses', () => {
  assert.equal(jobStatusLabel('succeeded'), '成功');
  assert.equal(jobStatusLabel('succeeded_with_warnings'), '有警告');
  assert.equal(jobStatusLabel('failed'), '失败');
  assert.equal(jobStatusLabel('running'), '进行中');
  assert.equal(jobStatusLabel('brand_new_status'), 'brand_new_status', '未知状态原样透出');
});

test('formatDuration renders ms below one second and seconds above', () => {
  assert.equal(formatDuration(320), '320ms');
  assert.equal(formatDuration(93600), '93.6s');
  assert.equal(formatDuration(1000), '1.0s');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(Number.NaN), '—');
  assert.equal(formatDuration(-5), '—');
});

test('jobTotalLabel shows 进行中 for non-terminal jobs and totalMs for terminal ones', () => {
  assert.equal(jobTotalLabel({ status: 'running', totalMs: null }), '进行中');
  assert.equal(jobTotalLabel({ status: 'queued' }), '进行中');
  assert.equal(jobTotalLabel({ status: 'succeeded', totalMs: 93600 }), '93.6s');
  assert.equal(jobTotalLabel({ status: 'failed', totalMs: null }), '—', '终态缺 totalMs 兜底');
});

test('formatClock renders HH:MM:SS with zero padding', () => {
  const ms = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(formatClock(ms), '03:04:05');
  assert.equal(formatClock(undefined), '—');
});

test('jobDisplayTitle prefers title, falls back to host then raw url', () => {
  assert.equal(jobDisplayTitle({ title: '  文章标题  ', sourceUrl: 'https://a.com/x' }), '文章标题');
  assert.equal(jobDisplayTitle({ title: null, sourceUrl: 'https://blog.example.com/post/1?x=2' }), 'blog.example.com');
  assert.equal(jobDisplayTitle({ sourceUrl: 'not a url' }), 'not a url');
  assert.equal(jobDisplayTitle({}), '未知任务');
});

test('jobDetailRows flattens clientTiming and timeline with indent levels', () => {
  const job = {
    clientTiming: { extractMs: 800 },
    timeline: [
      { kind: 'stage', name: 'create_document', ms: 1200 },
      { kind: 'stage', name: 'images', ms: 90000 },
      { kind: 'image', name: 'image-1', ms: 3000 },
      { kind: 'image', name: 'image-2', ms: 0, detail: '下载超时' },
      { kind: 'cli', name: 'docs +update', ms: 1500 },
    ],
  };
  assert.deepEqual(jobDetailRows(job), [
    { label: '页面提取', value: '800ms', indent: 0, failed: false },
    { label: '创建文档', value: '1.2s', indent: 0, failed: false },
    { label: '图片处理', value: '90.0s', indent: 0, failed: false },
    { label: '图片 1', value: '3.0s', indent: 1, failed: false },
    { label: '图片 2', value: '失败：下载超时', indent: 1, failed: true },
    { label: 'docs +update', value: '1.5s', indent: 2, failed: false },
  ]);
});

test('jobDetailRows tolerates missing timing data', () => {
  assert.deepEqual(jobDetailRows({}), []);
  assert.deepEqual(jobDetailRows({ clientTiming: null, timeline: null }), []);
  assert.deepEqual(
    jobDetailRows({ timeline: [{ kind: 'stage', name: 'unknown_stage', ms: 100 }] }),
    [{ label: 'unknown_stage', value: '100ms', indent: 0, failed: false }],
    '未知 stage 名原样透出',
  );
});

// ——— AI 摘要（#75）：digest 阶段中文名 + 设置页 AI 配置的常量与归约 ———

import {
  AI_API_TYPE_OPTIONS,
  AI_DEFAULT_BASE_URLS,
  aiConfigPayload,
  aiDefaultBaseUrl,
  aiHeadersToText,
  aiTestResultView,
} from '../src/extension/options-state.js';

test('jobDetailRows renders the digest stage with its Chinese label (#75)', () => {
  assert.deepEqual(
    jobDetailRows({ timeline: [{ kind: 'stage', name: 'digest', ms: 1200 }] }),
    [{ label: 'AI 摘要', value: '1.2s', indent: 0, failed: false }],
  );
});

test('AI_API_TYPE_OPTIONS lists the three contract apiTypes with display labels', () => {
  assert.deepEqual(AI_API_TYPE_OPTIONS.map((option) => option.value), ['responses', 'chat-completions', 'messages']);
  for (const option of AI_API_TYPE_OPTIONS) assert.ok(option.label, `${option.value} 应有展示名`);
});

test('AI_DEFAULT_BASE_URLS matches the bridge contract defaults; messages base has no /v1', () => {
  assert.equal(AI_DEFAULT_BASE_URLS.responses, 'https://api.openai.com/v1');
  assert.equal(AI_DEFAULT_BASE_URLS['chat-completions'], 'https://api.openai.com/v1');
  assert.equal(AI_DEFAULT_BASE_URLS.messages, 'https://api.anthropic.com');
  assert.equal(aiDefaultBaseUrl('messages'), 'https://api.anthropic.com');
  assert.equal(aiDefaultBaseUrl('bogus'), AI_DEFAULT_BASE_URLS.responses, '未知类型回落 responses 默认');
});

test('aiConfigPayload fills the default baseUrl and omits a blank apiKey (keep stored key)', () => {
  assert.deepEqual(aiConfigPayload({ apiType: 'messages', baseUrl: '', model: 'claude-haiku-4-5', apiKey: '' }), {
    apiType: 'messages',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5',
  }, '空 apiKey 不进 body');
  assert.deepEqual(aiConfigPayload({ apiType: 'chat-completions', baseUrl: ' https://proxy.local/v1 ', model: ' gpt-5-mini ', apiKey: 'sk-x' }), {
    apiType: 'chat-completions',
    baseUrl: 'https://proxy.local/v1',
    model: 'gpt-5-mini',
    apiKey: 'sk-x',
  }, '显式 baseUrl/model 去空白后透传');
  assert.equal(aiConfigPayload({ apiType: 'weird' }).apiType, 'responses', '非法 apiType 归一为 responses');
});

test('aiTestResultView renders success with latency and reply excerpt, failure with Chinese message', () => {
  const ok = aiTestResultView({ ok: true, latencyMs: 820, reply: 'ok' });
  assert.equal(ok.tone, 'success');
  assert.match(ok.text, /连接成功/);
  assert.match(ok.text, /820ms/);
  assert.match(ok.text, /ok/);
  assert.equal(aiTestResultView({ ok: false, code: 'AI_AUTH_FAILED', message: 'invalid key' }).text, '连接失败：API key 无效或权限不足', '已知机器码用固定中文文案');
  assert.equal(aiTestResultView({ ok: false, code: 'AI_REQUEST_FAILED', message: 'HTTP 500' }).text, '连接失败：HTTP 500', '未知错误透传 message');
  assert.equal(aiTestResultView(null).tone, 'error');
});


test('aiConfigPayload parses 高级设置：headersText 逐行解析 + maxOutputTokensText/timeoutText 整数', () => {
  const payload = aiConfigPayload({
    apiType: 'responses', model: 'gpt-5-mini', apiKey: 'sk-x',
    headersText: 'x-opencode-session: sess-1\n\n  x-foo:  bar  ', maxOutputTokensText: ' 4096 ', timeoutText: ' 300 ',
  });
  assert.deepEqual(payload.headers, { 'x-opencode-session': 'sess-1', 'x-foo': 'bar' }, '逐行 Name: value，去空白、跳过空行');
  assert.equal(payload.maxOutputTokens, 4096);
  assert.equal(payload.timeoutMs, 300_000, '超时秒数换算成毫秒');

  const bare = aiConfigPayload({ apiType: 'responses', model: 'm', headersText: ' \n  ', maxOutputTokensText: '', timeoutText: '' });
  assert.ok(!('headers' in bare) && !('maxOutputTokens' in bare) && !('timeoutMs' in bare), '留空则三项都不进 body（bridge 回落已存/默认）');

  assert.throws(() => aiConfigPayload({ apiType: 'responses', model: 'm', headersText: 'no-colon-line' }), /请求头/);
  assert.throws(() => aiConfigPayload({ apiType: 'responses', model: 'm', headersText: ': v' }), /请求头/);
  assert.throws(() => aiConfigPayload({ apiType: 'responses', model: 'm', maxOutputTokensText: 'abc' }), /tokens/i);
  assert.throws(() => aiConfigPayload({ apiType: 'responses', model: 'm', maxOutputTokensText: '3.5' }), /tokens/i);
  assert.throws(() => aiConfigPayload({ apiType: 'responses', model: 'm', timeoutText: 'abc' }), /超时/);
  assert.throws(() => aiConfigPayload({ apiType: 'responses', model: 'm', timeoutText: '3.5' }), /超时/);
});

test('aiHeadersToText serializes saved headers back to textarea lines', () => {
  assert.equal(aiHeadersToText({ 'x-opencode-session': 'sess-1', 'x-foo': 'bar' }), 'x-opencode-session: sess-1\nx-foo: bar');
  assert.equal(aiHeadersToText(undefined), '');
  assert.equal(aiHeadersToText({}), '');
});

// ——— 设置页分区折叠（#76）：折叠状态存 chrome.storage.local 单键，默认展开 ———

import {
  COLLAPSIBLE_SECTIONS,
  normalizeCollapsedSections,
  setSectionCollapsed,
} from '../src/extension/options-state.js';

test('COLLAPSIBLE_SECTIONS registers exactly the AI 摘要 and 预设管理 sections', () => {
  assert.deepEqual(COLLAPSIBLE_SECTIONS, [
    { id: 'ai-section-collapse', key: 'aiDigest' },
    { id: 'presets-section-collapse', key: 'presets' },
  ]);
});

test('normalizeCollapsedSections defaults to expanded and coerces garbage', () => {
  assert.deepEqual(normalizeCollapsedSections(undefined), { aiDigest: false, presets: false }, '首次打开（无历史状态）默认展开');
  assert.deepEqual(normalizeCollapsedSections({ aiDigest: true }), { aiDigest: true, presets: false }, '缺键补默认');
  assert.deepEqual(normalizeCollapsedSections({ aiDigest: 'yes', presets: 1 }), { aiDigest: false, presets: false }, '非布尔值归一为展开');
  assert.deepEqual(normalizeCollapsedSections('junk'), { aiDigest: false, presets: false }, '非对象归一为展开');
});

test('setSectionCollapsed toggles one key immutably', () => {
  const before = { aiDigest: false, presets: false };
  const after = setSectionCollapsed(before, 'presets', true);
  assert.deepEqual(after, { aiDigest: false, presets: true });
  assert.deepEqual(before, { aiDigest: false, presets: false }, '不改动入参');
  assert.deepEqual(setSectionCollapsed(after, 'presets', false), before, '再展开回到默认');
});

// ——— AI provider 预设管理（#77）：列表选中解析 + 保存请求体带 name/renameFrom ———

import {
  aiDigestProviderOptions,
  aiProviderByName,
  resolveAiProviderSelection,
} from '../src/extension/options-state.js';

test('aiConfigPayload carries provider name and renameFrom when given', () => {
  const payload = aiConfigPayload({ apiType: 'responses', model: 'm', apiKey: 'k', name: ' ds ', renameFrom: 'old' });
  assert.equal(payload.name, 'ds');
  assert.equal(payload.renameFrom, 'old');
  const plain = aiConfigPayload({ apiType: 'responses', model: 'm' });
  assert.ok(!('name' in plain) && !('renameFrom' in plain), '省略时两键不进 body');
});

test('aiProviderByName / resolveAiProviderSelection：命中、被删回落「默认」、再回落第一个、空列表 null', () => {
  const providers = [
    { name: '默认', apiType: 'responses', hasKey: true },
    { name: 'ds', apiType: 'chat-completions', hasKey: true },
  ];
  assert.equal(aiProviderByName(providers, 'ds').apiType, 'chat-completions');
  assert.equal(aiProviderByName(providers, 'ghost'), null);
  assert.equal(resolveAiProviderSelection(providers, 'ds'), 'ds', '选中有效原样保留');
  assert.equal(resolveAiProviderSelection(providers, 'ghost'), '默认', '选中不存在回落「默认」');
  assert.equal(resolveAiProviderSelection([{ name: 'ds' }], null), 'ds', '无「默认」回落第一个');
  assert.equal(resolveAiProviderSelection([], null), null, '空列表 → null（新建草稿态）');
  assert.equal(resolveAiProviderSelection(undefined, 'x'), null, 'undefined 列表按空处理');
});

// 预设表单的 provider 下拉选项（#78）：首项固定「默认」（value '' = 跟随默认 provider），
// 其后为各命名 provider（名为「默认」的已含于首项语义，不重复列）；列表不可用 → 仅首项
test('aiDigestProviderOptions：默认首项 + 命名 provider，列表缺失时仅默认项', () => {
  assert.deepEqual(aiDigestProviderOptions([
    { name: '默认', hasKey: true },
    { name: 'ds', hasKey: true },
    { name: 'xx', hasKey: false },
  ]), [
    { value: '', label: '默认' },
    { value: 'ds', label: 'ds' },
    { value: 'xx', label: 'xx' },
  ]);
  assert.deepEqual(aiDigestProviderOptions(undefined), [{ value: '', label: '默认' }], 'bridge 拿不到列表降级为仅默认');
  assert.deepEqual(aiDigestProviderOptions([]), [{ value: '', label: '默认' }]);
});
