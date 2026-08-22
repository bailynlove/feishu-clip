import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeJobView,
  initPopupPresets,
  currentPreset,
  selectPreset,
  overrideDestination,
  editTitle,
  editCustomBody,
  isCustomBodyEdited,
  resetTitle,
  isTitleEdited,
  primaryLabel,
  finalTitle,
  toggleSection,
  previewBody,
  previewScrollTarget,
  matchTrigger,
  isSessionModified,
  setIncludeImages,
  saveAsNewPreset,
  composeClip,
  clipFilename,
  setMenuOpen,
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
  assert.equal(primaryLabel('clipboard'), '⧉ 复制到剪贴板');
  assert.equal(primaryLabel('file'), '💾 保存为文件');
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

test('customBody is prefilled from the selected preset bodyTemplate and edits stay session-only', () => {
  const withBody = [{ ...presets[0], bodyTemplate: '来源：{{host}}' }];
  let state = initPopupPresets({ presets: withBody, defaultPresetId: 'p1' }, tab, now);
  assert.equal(state.customBody, '来源：{{host}}', 'prefill = preset bodyTemplate');
  assert.equal(isCustomBodyEdited(state), false);
  state = editCustomBody(state, '临时批注\n多行 {{host}}');
  assert.equal(state.customBody, '临时批注\n多行 {{host}}', 'raw multiline input is stored verbatim');
  assert.equal(isCustomBodyEdited(state), true);
  assert.equal(currentPreset(state).bodyTemplate, '来源：{{host}}', 'session edits never touch the preset itself');
});

test('switching presets applies the new preset bodyTemplate and clears the previous session edit', () => {
  const withBody = [
    { ...presets[0], bodyTemplate: '来源：{{host}}' },
    { ...presets[1], bodyTemplate: '' },
  ];
  let state = initPopupPresets({ presets: withBody, defaultPresetId: 'p1' }, tab, now);
  state = editCustomBody(state, '我改过的');
  state = selectPreset(state, 'p2');
  assert.equal(state.customBody, '', 'p2 has an empty bodyTemplate');
  state = selectPreset(state, 'p1');
  assert.equal(state.customBody, '来源：{{host}}');
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

test('previewBody uses the custom body as the effective template: {{content}} before/after/wrapped/multiline', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  const content = '# 正文\n\n内容';
  assert.equal(previewBody(editCustomBody(state, 'xxxx {{content}}'), clipSnapshot), `xxxx ${content}`);
  assert.equal(previewBody(editCustomBody(state, '{{content}} xxxx'), clipSnapshot), `${content} xxxx`);
  assert.equal(previewBody(editCustomBody(state, 'xxxx\n{{content}}'), clipSnapshot), `xxxx\n${content}`);
  assert.equal(previewBody(editCustomBody(state, '前 {{content}} 后'), clipSnapshot), `前 ${content} 后`);
});

test('previewBody with an empty custom body renders only the clip content', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  assert.equal(state.customBody, '', 'fixture presets have no bodyTemplate, so the box starts empty');
  assert.equal(previewBody(state, clipSnapshot), '# 正文\n\n内容');
  assert.equal(previewBody(editCustomBody(state, '   '), clipSnapshot), '# 正文\n\n内容', 'blank template still falls back to content only');
});

test('previewBody title variable resolves to the final (edited, re-rendered) title', () => {
  const withBody = [{ ...presets[0], bodyTemplate: '{{title}}：{{content}}' }];
  let state = initPopupPresets({ presets: withBody, defaultPresetId: 'p1' }, tab, now);
  state = editTitle(state, '改过的 {{date|date:YYYY}} 标题');
  assert.equal(previewBody(state, clipSnapshot), '改过的 2026 标题：# 正文\n\n内容');
});

// ——— #37 验收 bug 回归（#40 改自定义正文后调为三向锚点）：预览内滚区要滚到自定义文本所在端 ———

test('previewScrollTarget follows where the custom text lands in the composed body', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  assert.equal(previewScrollTarget('refresh', editCustomBody(state, '追加在后')), null, 'title/preset refreshes keep the scroll position');
  // 无占位符：整段追加在正文后 → 滚到底
  assert.equal(previewScrollTarget('body', editCustomBody(state, '追加在后')), 'end');
  // 占位符后有内容（{{content}} xxxx）：自定义文本在末尾 → 滚到底
  assert.equal(previewScrollTarget('body', editCustomBody(state, '{{content}} xxxx')), 'end');
  // 占位符在末尾（xxxx {{content}}）：自定义文本全在正文前 → 滚到顶
  assert.equal(previewScrollTarget('body', editCustomBody(state, 'xxxx {{content}}')), 'top');
  // 模板清空（只要正文）：无需滚动
  assert.equal(previewScrollTarget('body', editCustomBody(state, '')), null);
});

test('previewScrollTarget on open jumps to the custom text only when the user edited it', () => {
  const withBody = [{ ...presets[0], bodyTemplate: '来源：{{host}}' }];
  let state = initPopupPresets({ presets: withBody, defaultPresetId: 'p1' }, tab, now);
  assert.equal(previewScrollTarget('open', state), null, 'unmodified prefill opens at the top');
  state = editCustomBody(state, '已有自定义');
  assert.equal(previewScrollTarget('open', state), 'end', 'edited custom body jumps into view on open');
});

// ——— #39：triggers 自动命中预设 ———

const triggerPresets = [
  { id: 't1', name: '博客', titleTemplate: '{{title}}', action: 'feishu', destination: null, includeImages: true, triggers: ['https://blog.example.com'] },
  { id: 't2', name: '博客长前缀', titleTemplate: '{{title}}', action: 'feishu', destination: null, includeImages: true, triggers: ['https://blog.example.com/posts'] },
  { id: 't3', name: '正则', titleTemplate: '{{title}}', action: 'feishu', destination: null, includeImages: true, triggers: ['/example\\.com\\/posts\\/\\d+/'] },
];
const triggerTab = { title: 'T', url: 'https://blog.example.com/posts/42' };

test('matchTrigger: longest prefix wins', () => {
  assert.equal(matchTrigger(triggerPresets, triggerTab.url), 't2');
});

test('matchTrigger: equal-length prefixes resolve by preset list order', () => {
  const tied = [
    { id: 'a', triggers: ['https://blog.example.com'] },
    { id: 'b', triggers: ['https://blog.example.com'] },
  ];
  assert.equal(matchTrigger(tied, triggerTab.url), 'a');
});

test('matchTrigger: a matching prefix beats any matching regex', () => {
  const regexFirst = [
    { id: 'rx', triggers: ['/example\\.com/'] },
    { id: 'px', triggers: ['https://blog.example.com'] },
  ];
  assert.equal(matchTrigger(regexFirst, triggerTab.url), 'px', 'prefix wins even when the regex preset comes first');
});

test('matchTrigger: matching regexes resolve by preset list order, and /…/i is case-insensitive', () => {
  const regexes = [
    { id: 'r1', triggers: ['/BLOG\\.EXAMPLE\\.COM/i'] },
    { id: 'r2', triggers: ['/example/'] },
  ];
  assert.equal(matchTrigger(regexes, triggerTab.url), 'r1');
});

test('matchTrigger: no hit returns null and init falls back to the default preset', () => {
  assert.equal(matchTrigger(triggerPresets, 'https://unrelated.org/x'), null);
  const state = initPopupPresets({ presets: triggerPresets, defaultPresetId: 't1' }, { title: 'T', url: 'https://unrelated.org/x' }, now);
  assert.equal(state.presetId, 't1');
  assert.equal(state.viaTrigger, false, 'no hit means no auto-select hint');
});

test('matchTrigger skips malformed input defensively', () => {
  const bad = [
    { id: 'bad', triggers: ['/unclosed[/', '', null, 42] },
    { id: 'good', triggers: ['https://blog.example.com'] },
  ];
  assert.equal(matchTrigger(bad, triggerTab.url), 'good');
  assert.equal(matchTrigger(null, triggerTab.url), null);
  assert.equal(matchTrigger(bad, ''), null);
});

test('init applies the matched preset and marks viaTrigger; a manual switch clears the hint', () => {
  let state = initPopupPresets({ presets: triggerPresets, defaultPresetId: 't1' }, triggerTab, now);
  assert.equal(state.presetId, 't2', 'longest-prefix preset is auto-selected');
  assert.equal(state.viaTrigger, true);
  state = selectPreset(state, 't1');
  assert.equal(state.viaTrigger, false, 'manual override leaves trigger mode for this session');
});

// ——— #40：保存为新预设 ———

test('isSessionModified compares the four popup-editable fields against their baselines', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  assert.equal(isSessionModified(state), false, 'fresh session matches the preset');
  // 仅本次目标不同 → 修改；手动覆盖成相同目标（按值比较）不算修改
  assert.equal(isSessionModified(overrideDestination(state, nodeTarget)), true);
  assert.equal(isSessionModified(overrideDestination(state, { ...spaceTarget })), false);
  // 包含图片不同 → 修改
  assert.equal(isSessionModified(setIncludeImages(state, false)), true);
  // 标题编辑 → 修改；基线是渲染后的预填值而非模板原始串（{{title}} 永不误报）
  assert.equal(isSessionModified(editTitle(state, '别的标题')), true);
  assert.equal(isSessionModified(editTitle(state, '深入理解剪藏')), false, 'typing back the rendered baseline is not a modification');
  // 自定义正文编辑 → 修改；基线是预填的预设 bodyTemplate
  assert.equal(isSessionModified(editCustomBody(state, '临时自定义')), true);
  assert.equal(isSessionModified(editCustomBody(state, '')), false, 'fixture bodyTemplate is empty, so empty box matches the baseline');
});

test('setIncludeImages stores the per-session switch state', () => {
  const state = initPopupPresets({ presets, defaultPresetId: 'p2' }, tab, now);
  assert.equal(state.includeImages, false);
  assert.equal(setIncludeImages(state, true).includeImages, true);
  assert.equal(setIncludeImages(state, true).includeImages, true);
});

test('saveAsNewPreset inherits the source preset and overrides the two session fields', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = setIncludeImages(overrideDestination(state, nodeTarget), false);
  const result = saveAsNewPreset(state, '  我的归档  ');
  assert.equal(result.state.presets.length, presets.length + 1);
  const created = result.preset;
  assert.notEqual(created.id, 'p1');
  assert.equal(created.name, '我的归档', 'name is trimmed');
  assert.deepEqual(created.destination, nodeTarget);
  assert.equal(created.includeImages, false);
  assert.equal(created.titleTemplate, presets[0].titleTemplate, '标题未改时沿用源预设模板');
  assert.equal(created.bodyTemplate, '', 'bodyTemplate 恒取当前自定义正文框内容');
  assert.equal(created.action, 'feishu', '其余字段继承所选预设');
  created.triggers.push('x');
  assert.equal((presets[0].triggers ?? []).length, 0, 'triggers are copied, not shared');
  // 选中新预设，且不触发「换预设清仅本次」：目标保留、徽标态清除
  assert.equal(result.state.presetId, created.id);
  assert.equal(result.state.temporary, false);
  assert.deepEqual(result.state.destination, nodeTarget);
  assert.equal(isSessionModified(result.state), false, 'current settings now equal the new preset, button hides');
});

test('saveAsNewPreset keeps a manually edited title and clears the trigger hint', () => {
  let state = initPopupPresets({ presets: triggerPresets, defaultPresetId: 't1' }, triggerTab, now);
  assert.equal(state.viaTrigger, true);
  state = editTitle(state, '手改标题');
  const { state: next } = saveAsNewPreset(state, 'x');
  assert.equal(next.title, '手改标题');
  assert.equal(next.viaTrigger, false);
});

test('saveAsNewPreset rejects blank names', () => {
  const state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  assert.equal(saveAsNewPreset(state, ''), null);
  assert.equal(saveAsNewPreset(state, '   '), null);
  assert.equal(saveAsNewPreset(state, null), null);
});

test('saveAsNewPreset captures an edited title as the new template and the current custom body', () => {
  const withBody = [{ ...presets[0], bodyTemplate: '来源：{{host}}' }];
  let state = initPopupPresets({ presets: withBody, defaultPresetId: 'p1' }, tab, now);
  state = editCustomBody(editTitle(state, '我的固定标题'), '{{content}}\n\n批注');
  const { preset: created, state: next } = saveAsNewPreset(state, '捕获');
  assert.equal(created.titleTemplate, '我的固定标题', 'edited title freezes into the new preset template');
  assert.equal(created.bodyTemplate, '{{content}}\n\n批注');
  assert.equal(isSessionModified(next), false, 'plain-text title renders to itself, so the new preset matches the session');
});

// ——— #38：导出动作 ———

test('composeClip shares the save/preview render path: semantic-B title with sanitize, renderBody for the body', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = editCustomBody(editTitle(state, '我的 标题/收藏'), '{{content}}\n\n批注 {{host}}');
  const clip = composeClip(state, clipSnapshot);
  assert.equal(clip.title, '我的 标题-收藏', 'title re-rendered then filename-sanitized');
  assert.equal(clip.body, '# 正文\n\n内容\n\n批注 blog.example.com');
  assert.equal(previewBody(state, clipSnapshot), clip.body, 'preview === export body');
});

test('composeClip falls back to the extractor title when the rendered title is blank', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  state = editTitle(state, '{{unknown}}');
  assert.equal(composeClip(state, clipSnapshot).title, '深入理解剪藏');
});

test('clipFilename sanitizes filesystem-unsafe characters and falls back to clip', () => {
  assert.equal(clipFilename('我的 标题/收藏?'), '我的 标题-收藏-.md');
  assert.equal(clipFilename('  正常标题  '), '正常标题.md');
  assert.equal(clipFilename(''), 'clip.md');
  assert.equal(clipFilename('???'), '---.md');
  assert.equal(clipFilename('...'), 'clip.md', 'trailing dots are stripped, empty falls back');
});

test('action menu state is session-only and toggles independently', () => {
  let state = initPopupPresets({ presets, defaultPresetId: 'p1' }, tab, now);
  assert.equal(state.menuOpen, false);
  state = setMenuOpen(state, true);
  assert.equal(state.menuOpen, true);
  assert.equal(currentPreset(state).action, 'feishu', 'opening the menu never touches the preset action');
  assert.equal(setMenuOpen(state, false).menuOpen, false);
});
