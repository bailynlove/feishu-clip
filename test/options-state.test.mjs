import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultPreset } from '../src/extension/presets.js';
import {
  addPreset, duplicatePreset, movePreset, removePreset, renamePreset, setDefaultPreset, updatePreset,
  validateTriggers, parseTriggers, insertVariable, TEMPLATE_VARIABLES,
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
