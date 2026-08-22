import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeJobView,
  initPopupPresets,
  currentPreset,
  selectPreset,
  overrideDestination,
  editTitle,
  editAppend,
  resetTitle,
  isTitleEdited,
  primaryLabel,
  finalTitle,
  toggleSection,
  previewBody,
} from '../src/extension/popup-state.js';
import { sanitizeClipTitle } from '../src/extension/templates.js';

const succeededJob = { status: 'succeeded', warnings: [], document: { url: 'https://example.feishu.cn/wiki/docx-1' } };
const warningsJob = { status: 'succeeded_with_warnings', warnings: ['图片 1：超时'], document: { url: 'https://example.feishu.cn/wiki/docx-2' } };
const failedJob = { status: 'failed', error: '目标已失效' };

test('in-session success swaps the primary action to open-document', () => {
  const view = describeJobView(succeededJob, { recovered: false });
  assert.equal(view.kind, 'success');
  assert.equal(view.swapPrimary, true, 'this session’s save should surface the open-document action');
  assert.equal(view.documentUrl, succeededJob.document.url);
});

test('recovered terminal job must not hijack a fresh popup session', () => {
  // 用户症状：打开弹窗准备新一次剪藏（甚至还在选择目录），旧 job 的成功态顶掉了保存按钮
  const view = describeJobView(succeededJob, { recovered: true });
  assert.equal(view.kind, 'success');
  assert.equal(view.swapPrimary, false, 'stale recovered success must keep 保存到飞书 as the primary action');
  assert.equal(view.documentUrl, succeededJob.document.url, 'the old document stays reachable');
});

test('recovered partial success stays passive too', () => {
  const view = describeJobView(warningsJob, { recovered: true });
  assert.equal(view.kind, 'warning');
  assert.equal(view.swapPrimary, false);
});

test('failure never swaps the primary action and reports the error', () => {
  const view = describeJobView(failedJob, { recovered: false });
  assert.equal(view.kind, 'failure');
  assert.equal(view.message, '目标已失效');
  assert.equal(view.swapPrimary, false);
});

test('in-flight jobs keep polling with progress text', () => {
  assert.deepEqual(describeJobView({ status: 'queued' }, { recovered: true }), { kind: 'progress', message: '已提交，等待本地 Bridge 处理…', swapPrimary: false, documentUrl: null });
  assert.equal(describeJobView({ status: 'running' }, { recovered: false }).kind, 'progress');
});

// ——— #36：预设选择与可编辑标题 ———

const tab = { title: '深入理解剪藏', url: 'https://blog.example.com/posts/42' };
const now = new Date('2026-08-21T15:30:45');
const spaceTarget = { kind: 'space', spaceId: 'sp1', title: '知识库 A' };
const nodeTarget = { kind: 'node', nodeToken: 'nd2', spaceId: 'sp1', title: '归档目录' };
const presets = [
  { id: 'p1', name: '默认', titleTemplate: '{{title}}', action: 'feishu', destination: spaceTarget, includeImages: true },
  { id: 'p2', name: '归档', titleTemplate: '[{{host}}] {{title}} {{date|date:YYYYMMDD}}', action: 'clipboard', destination: nodeTarget, includeImages: false },
];

test('init selects the default preset and renders the title from its template', () => {
  const state = initPopupPresets({ presets, defaultPresetId: 'p2' }, tab, now);
  assert.equal(state.presetId, 'p2');
  assert.equal(state.title, '[blog.example.com] 深入理解剪藏 20260821');
  assert.equal(isTitleEdited(state), false);
});

test('dangling defaultPresetId falls back to the first preset', () => {
  const state = initPopupPresets({ presets, defaultPresetId: 'gone' }, tab, now);
  assert.equal(state.presetId, 'p1');
  assert.equal(state.title, '深入理解剪藏');
});

test('missing presets fall back to a migrated-style 默认 preset', () => {
  for (const settings of [{}, { presets: [] }, { presets: null, defaultPresetId: 'x' }]) {
    const state = initPopupPresets(settings, tab, now);
    assert.equal(state.presets.length, 1);
    assert.equal(currentPreset(state).name, '默认');
    assert.equal(state.title, '深入理解剪藏');
  }
});

test('switching presets re-renders the title with the new template', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = selectPreset(state, 'p2');
  assert.equal(state.title, '[blog.example.com] 深入理解剪藏 20260821');
  state = selectPreset(state, 'p1');
  assert.equal(state.title, '深入理解剪藏');
});

test('switching presets never overwrites a manually edited title', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = editTitle(state, '我的手写标题');
  assert.equal(isTitleEdited(state), true);
  state = selectPreset(state, 'p2');
  assert.equal(state.title, '我的手写标题');
  assert.equal(isTitleEdited(state), true, 'edited marker follows comparison with the new template render');
});

test('typing the rendered value back clears the edited marker', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = editTitle(state, '别的');
  state = editTitle(state, '深入理解剪藏');
  assert.equal(isTitleEdited(state), false);
});

test('reset restores the current preset template render', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = editTitle(state, '我的手写标题');
  state = selectPreset(state, 'p2');
  state = resetTitle(state);
  assert.equal(state.title, '[blog.example.com] 深入理解剪藏 20260821');
  assert.equal(isTitleEdited(state), false);
});

test('unknown or same preset id keeps state untouched', () => {
  const state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  assert.equal(selectPreset(state, 'p1'), state);
  assert.equal(selectPreset(state, 'nope'), state);
});

test('primary label follows the preset default action', () => {
  assert.equal(primaryLabel('feishu'), '⬇ 保存到飞书');
  assert.equal(primaryLabel('clipboard'), '复制到剪贴板');
  assert.equal(primaryLabel('file'), '保存为文件');
  assert.equal(primaryLabel('mystery'), '⬇ 保存到飞书', 'unknown actions fall back to the feishu label');
});

test('init applies the default preset destination and includeImages without the temporary badge', () => {
  const state = initPopupPresets({ presets, defaultPresetId: 'p2' }, tab, now);
  assert.deepEqual(state.destination, nodeTarget);
  assert.equal(state.includeImages, false);
  assert.equal(state.temporary, false, 'preset-owned destination must not wear the 仅本次 badge');
});

test('switching presets applies the new preset destination and includeImages', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  assert.deepEqual(state.destination, spaceTarget);
  assert.equal(state.includeImages, true);
  state = selectPreset(state, 'p2');
  assert.deepEqual(state.destination, nodeTarget);
  assert.equal(state.includeImages, false);
  assert.equal(state.temporary, false);
});

test('a preset without destination falls back to 尚未设置 and still saves-facing null', () => {
  const bare = [{ id: 'p1', name: '默认', titleTemplate: '{{title}}', action: 'feishu', destination: null, includeImages: true }];
  const state = initPopupPresets({ presets: bare, defaultPresetId: 'p1' }, tab, now);
  assert.equal(state.destination, null);
  assert.equal(state.temporary, false);
  assert.equal(state.includeImages, true, 'missing includeImages defaults to true');
});

test('switching presets clears a manual 仅本次 override and restarts from the new preset', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  const manual = { kind: 'node', nodeToken: 'manual', spaceId: 'sp9', title: '手动目录' };
  state = overrideDestination(state, manual);
  assert.deepEqual(state.destination, manual);
  assert.equal(state.temporary, true);
  state = selectPreset(state, 'p2');
  assert.deepEqual(state.destination, nodeTarget, 'temporary override does not survive a preset switch');
  assert.equal(state.temporary, false);
});

// ——— 语义 B：保存时标题框内容再过一遍模板渲染 ———

test('finalTitle re-renders template variables typed into the title input', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = editTitle(state, '【{{host}}】{{title}} @ {{date}}');
  assert.equal(finalTitle(state), '【blog.example.com】深入理解剪藏 @ 2026-08-21');
});

test('finalTitle is idempotent for an untouched, already-rendered title', () => {
  const state = initPopupPresets({ presets, defaultPresetId: 'p2' }, tab, now);
  assert.equal(finalTitle(state), state.title, 'rendered value contains no {{}}, second pass is a no-op');
});

test('finalTitle blanks unknown variables', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = editTitle(state, '{{author}} - 深入理解剪藏');
  assert.equal(finalTitle(state), ' - 深入理解剪藏');
});

test('a title rendering to blank falls back to the extractor title via sanitizeClipTitle', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = editTitle(state, '{{unknown}}');
  assert.equal(finalTitle(state), '');
  assert.equal(sanitizeClipTitle(finalTitle(state)), null, 'background must not override snapshot.title with a blank render');
});

// ——— #37：本次设置折叠区 + 预览 ———

const clipSnapshot = { title: '深入理解剪藏', sourceUrl: tab.url, capturedAt: now.toISOString(), markdown: '# 正文\n\n内容', images: [] };

test('append note starts empty and editAppend stores the raw input for this session only', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  assert.equal(state.appendNote, '');
  state = editAppend(state, '临时批注 {{host}}');
  assert.equal(state.appendNote, '临时批注 {{host}}');
  assert.equal(currentPreset(state).bodyTemplate, undefined, 'session edits never touch the preset itself');
});

test('the settings and preview folds toggle independently', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  assert.equal(state.settingsOpen, false);
  assert.equal(state.previewOpen, false);
  state = toggleSection(state, 'settings');
  assert.deepEqual([state.settingsOpen, state.previewOpen], [true, false]);
  state = toggleSection(state, 'preview');
  assert.deepEqual([state.settingsOpen, state.previewOpen], [true, true], 'opening preview must not close settings');
  state = toggleSection(state, 'settings');
  assert.deepEqual([state.settingsOpen, state.previewOpen], [false, true], 'closing settings must not close preview');
  assert.equal(toggleSection(state, 'bogus'), state);
});

test('previewBody composes preset bodyTemplate + clip content + append note, in prototype order', () => {
  const withBody = [{ ...presets[0], bodyTemplate: '来源：{{host}}' }];
  let state = initPopupPresets({ presets: withBody, defaultPresetId: 'p1' }, tab, now);
  state = editAppend(state, '注 {{date|date:YYYYMMDD}}');
  assert.equal(previewBody(state, clipSnapshot), '# 正文\n\n内容\n\n来源：blog.example.com\n\n注 20260821');
});

test('previewBody title variable resolves to the final (edited, re-rendered) title', () => {
  const withBody = [{ ...presets[0], bodyTemplate: '{{title}}：{{content}}' }];
  let state = initPopupPresets({ presets: withBody, defaultPresetId: 'p1' }, tab, now);
  state = editTitle(state, '改过的 {{date|date:YYYY}} 标题');
  assert.equal(previewBody(state, clipSnapshot), '改过的 2026 标题：# 正文\n\n内容');
});
