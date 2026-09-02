import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultPreset, ensurePresets, resolveImageMode } from '../src/extension/presets.js';

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(entries) {
      Object.assign(data, entries);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

const legacyDestination = { kind: 'node', spaceId: 'space-1', nodeToken: 'node-1', path: ['目录'] };

test('createDefaultPreset applies v1 defaults and lets callers override', () => {
  const preset = createDefaultPreset();
  assert.match(preset.id, /^[0-9a-f-]{36}$/);
  assert.equal(preset.name, '默认');
  assert.equal(preset.destination, null);
  assert.equal(preset.imageMode, 'preview');
  assert.equal(preset.titleTemplate, '{{title}}');
  assert.equal(preset.bodyTemplate, '');
  assert.equal(preset.action, 'feishu');
  assert.deepEqual(preset.triggers, []);

  const custom = createDefaultPreset({ name: '备用', destination: legacyDestination });
  assert.equal(custom.name, '备用');
  assert.deepEqual(custom.destination, legacyDestination);
});

test('ensurePresets migrates a legacy destination into the default preset and removes the legacy key', async () => {
  const storage = createStorage({ destination: legacyDestination, activeAttempt: 'keep-me' });
  const { presets, defaultPresetId } = await ensurePresets(storage);

  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, '默认');
  assert.deepEqual(presets[0].destination, legacyDestination);
  assert.equal(presets[0].titleTemplate, '{{title}}');
  assert.equal(defaultPresetId, presets[0].id);
  // expand–contract 收尾（#35）：迁移完成后删除旧 destination 键
  assert.equal('destination' in storage.data, false);
  assert.equal(storage.data.activeAttempt, 'keep-me', '不动其他键');
});

test('ensurePresets creates an empty-destination default preset when there is no legacy destination', async () => {
  const storage = createStorage({});
  const { presets, defaultPresetId } = await ensurePresets(storage);

  assert.equal(presets.length, 1);
  assert.equal(presets[0].destination, null);
  assert.equal(defaultPresetId, presets[0].id);
  assert.equal('destination' in storage.data, false, '无旧目标时不应写出 destination 键');
});

test('ensurePresets is idempotent across service worker cold starts', async () => {
  const storage = createStorage({ destination: legacyDestination });
  const first = await ensurePresets(storage);
  const second = await ensurePresets(storage);

  assert.deepEqual(second, first, '重复调用不得重新生成预设或 id');
  assert.equal(storage.data.presets.length, 1);
});

test('ensurePresets removes a stale legacy destination key instead of syncing it', async () => {
  const preset = createDefaultPreset({ destination: legacyDestination });
  const storage = createStorage({ presets: [preset], defaultPresetId: preset.id, destination: { kind: 'space', spaceId: 'stale' } });

  await ensurePresets(storage);
  assert.equal('destination' in storage.data, false, '旧键一律删除，不再回写');
});

test('ensurePresets repairs a dangling defaultPresetId to the first preset', async () => {
  const preset = createDefaultPreset();
  const storage = createStorage({ presets: [preset], defaultPresetId: 'gone' });
  const { defaultPresetId } = await ensurePresets(storage);
  assert.equal(defaultPresetId, preset.id);
});

// ——— 图片写入模式（#53）：三态 preview/download/off，读取时迁移存量 includeImages 布尔 ———

test('resolveImageMode passes through a valid stored imageMode', () => {
  assert.equal(resolveImageMode({ imageMode: 'preview' }), 'preview');
  assert.equal(resolveImageMode({ imageMode: 'download' }), 'download');
  assert.equal(resolveImageMode({ imageMode: 'off' }), 'off');
});

test('resolveImageMode migrates legacy includeImages without rewriting storage', () => {
  assert.equal(resolveImageMode({ includeImages: false }), 'off', '存量 includeImages:false 映射为不保存');
  assert.equal(resolveImageMode({ includeImages: true }), 'preview', '其余映射为预览优先');
  assert.equal(resolveImageMode({}), 'preview', '缺字段按默认预览优先');
  assert.equal(resolveImageMode(null), 'preview');
});

test('resolveImageMode prefers imageMode over the legacy boolean and ignores invalid values', () => {
  assert.equal(resolveImageMode({ imageMode: 'download', includeImages: false }), 'download', 'imageMode 优先于旧布尔');
  assert.equal(resolveImageMode({ imageMode: 'bogus', includeImages: false }), 'off', '非法 imageMode 回退到旧布尔迁移');
});
