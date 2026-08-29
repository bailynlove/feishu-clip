import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultPreset } from '../src/extension/presets.js';
import {
  addPreset, duplicatePreset, movePreset, removePreset, renamePreset, setDefaultPreset, updatePreset,
  validateTriggers, parseTriggers, insertVariable, TEMPLATE_VARIABLES,
  jobStatusTone, jobStatusLabel, formatDuration, jobTotalLabel, formatClock, jobDisplayTitle, jobDetailRows,
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
  const next = updatePreset(state, state.presets[0].id, { includeImages: false, action: 'file' });
  assert.equal(next.presets[0].includeImages, false);
  assert.equal(next.presets[0].action, 'file');
  assert.equal(state.presets[0].includeImages, true, '不改原 state');
  assert.equal(updatePreset(state, 'nope', { name: 'x' }), state);
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

test('TEMPLATE_VARIABLES covers the v1 variable set (#30)', () => {
  assert.deepEqual(TEMPLATE_VARIABLES, ['title', 'url', 'host', 'date', 'time', 'datetime', 'content']);
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
