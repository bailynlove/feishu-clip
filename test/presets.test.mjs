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

// ——— PDF 存云盘预设字段（#62/#65）：读取时迁移，非法值一律归一为 null ———

import { resolvePdfDrive } from '../src/extension/presets.js';

test('createDefaultPreset 的 pdfDrive 缺省为 null（关闭态）', () => {
  assert.equal(createDefaultPreset().pdfDrive, null);
});

test('resolvePdfDrive：缺字段/非法值一律归一为 null', () => {
  for (const preset of [
    {},
    { pdfDrive: null },
    { pdfDrive: 'on' },
    { pdfDrive: { enabled: false } },
    { pdfDrive: { enabled: 'yes' } },
    { pdfDrive: { enabled: true, folderToken: 42 } }, // folderToken 非字符串 → 归一为根目录
    null,
    undefined,
  ]) {
    if (preset?.pdfDrive?.enabled === true) {
      assert.deepEqual(resolvePdfDrive(preset), { enabled: true, folderToken: null, folderName: null });
    } else {
      assert.equal(resolvePdfDrive(preset), null, JSON.stringify(preset));
    }
  }
});

test('resolvePdfDrive：enabled:true + folderToken:null = 云盘根目录（合法态）', () => {
  assert.deepEqual(resolvePdfDrive({ pdfDrive: { enabled: true, folderToken: null, folderName: null } }), {
    enabled: true,
    folderToken: null,
    folderName: null,
  });
});

test('resolvePdfDrive：完整结构透传 folderToken 与 folderName（picker 归 #66）', () => {
  assert.deepEqual(resolvePdfDrive({ pdfDrive: { enabled: true, folderToken: 'fldcnABC', folderName: '论文' } }), {
    enabled: true,
    folderToken: 'fldcnABC',
    folderName: '论文',
  });
});

// ——— AI 摘要预设字段（#75）：读取时迁移，非法值一律归一为 null ———

import { DEFAULT_DIGEST_INSTRUCTION, readDigestConfig, resolveDigest, resolveDigestInstruction } from '../src/extension/presets.js';

test('createDefaultPreset 的 digest 缺省为 null（关闭态）', () => {
  assert.equal(createDefaultPreset().digest, null);
});

test('DEFAULT_DIGEST_INSTRUCTION 是内置默认摘要指令文案', () => {
  assert.equal(DEFAULT_DIGEST_INSTRUCTION, '请用与正文相同的语言，把以下网页正文总结为 3-6 条要点，每条一句话，直接输出要点列表，不要输出额外解释。');
});

test('resolveDigest：缺字段/非法值一律归一为 null', () => {
  for (const preset of [
    {},
    { digest: null },
    { digest: 'on' },
    { digest: { enabled: false } },
    { digest: { enabled: 'yes' } },
    { digest: { enabled: true, instruction: '' }, extra: true }, // 合法，见下个断言
    null,
    undefined,
  ]) {
    if (preset?.digest?.enabled === true) {
      assert.deepEqual(resolveDigest(preset), { enabled: true, instruction: '', provider: '', mode: 'subdoc', docTitleTemplate: 'Digest' }, '多余字段不携带');
    } else {
      assert.equal(resolveDigest(preset), null, JSON.stringify(preset));
    }
  }
});

test('resolveDigest：enabled:true 透传 instruction；非字符串 instruction 归一为空串（= 用全局）', () => {
  assert.deepEqual(resolveDigest({ digest: { enabled: true, instruction: '只保留结论' } }), { enabled: true, instruction: '只保留结论', provider: '', mode: 'subdoc', docTitleTemplate: 'Digest' });
  assert.deepEqual(resolveDigest({ digest: { enabled: true } }), { enabled: true, instruction: '', provider: '', mode: 'subdoc', docTitleTemplate: 'Digest' });
  assert.deepEqual(resolveDigest({ digest: { enabled: true, instruction: 42 } }), { enabled: true, instruction: '', provider: '', mode: 'subdoc', docTitleTemplate: 'Digest' });
});

// mode/docTitleTemplate（#98）：mode 缺省与非法值读作 'subdoc'（存量预设读侧迁移，改回
// inline 可还原）；docTitleTemplate 非空白字符串直用，缺省/空白回落 'Digest'
test('resolveDigest：mode 缺省读作 subdoc，inline 原样保留，非法值归一 subdoc', () => {
  assert.equal(resolveDigest({ digest: { enabled: true } }).mode, 'subdoc', '缺省 = subdoc（存量预设迁移）');
  assert.equal(resolveDigest({ digest: { enabled: true, mode: 'inline' } }).mode, 'inline', 'inline 可还原');
  assert.equal(resolveDigest({ digest: { enabled: true, mode: 'subdoc' } }).mode, 'subdoc');
  assert.equal(resolveDigest({ digest: { enabled: true, mode: 'weird' } }).mode, 'subdoc', '非法值归一 subdoc');
  assert.equal(resolveDigest({ digest: { enabled: true, mode: 42 } }).mode, 'subdoc', '非字符串归一 subdoc');
});

test('resolveDigest：docTitleTemplate 缺省/空白回落 Digest，非空白原样透传', () => {
  assert.equal(resolveDigest({ digest: { enabled: true } }).docTitleTemplate, 'Digest');
  assert.equal(resolveDigest({ digest: { enabled: true, docTitleTemplate: '' } }).docTitleTemplate, 'Digest', '空白回落默认');
  assert.equal(resolveDigest({ digest: { enabled: true, docTitleTemplate: 42 } }).docTitleTemplate, 'Digest', '非字符串回落默认');
  assert.equal(resolveDigest({ digest: { enabled: true, docTitleTemplate: '摘要 · {{date}}' } }).docTitleTemplate, '摘要 · {{date}}', '模板原样透传');
});

// provider（#78）：预设选用的 AI provider 名；空串 = 默认 provider。缺省/非字符串归一为空串
test('resolveDigest：provider 字段透传与归一', () => {
  assert.equal(resolveDigest({ digest: { enabled: true, instruction: '', provider: 'ds' } }).provider, 'ds');
  assert.equal(resolveDigest({ digest: { enabled: true, instruction: '', provider: ' xx ' } }).provider, 'xx', '去空白');
  assert.equal(resolveDigest({ digest: { enabled: true, instruction: '', provider: 42 } }).provider, '', '非字符串归一为空串');
  assert.equal(resolveDigest({ digest: { enabled: true, instruction: '' } }).provider, '', '缺省 = 默认 provider');
});

test('resolveDigestInstruction：预设级 > 全局 > 内置默认；空串/非字符串视为未设置', () => {
  assert.equal(resolveDigestInstruction('预设指令', '全局指令'), '预设指令', '预设级优先');
  assert.equal(resolveDigestInstruction('', '全局指令'), '全局指令', '预设空串回落全局');
  assert.equal(resolveDigestInstruction(undefined, '全局指令'), '全局指令');
  assert.equal(resolveDigestInstruction('  ', null), DEFAULT_DIGEST_INSTRUCTION, '空白全局都未设置回落内置默认');
  assert.equal(resolveDigestInstruction(null, undefined), DEFAULT_DIGEST_INSTRUCTION);
});

// ——— readDigestConfig：设置页编辑器读取路径——开关只折叠不清空，关闭态也要读得出已存配置 ———

test('readDigestConfig：从未配置（缺字段/null/非对象）返回 null', () => {
  for (const preset of [{}, { digest: null }, { digest: 'on' }, null, undefined]) {
    assert.equal(readDigestConfig(preset), null, JSON.stringify(preset));
  }
});

test('readDigestConfig：关闭态保留已存配置（enabled:false 不归 null）', () => {
  const stored = { enabled: false, instruction: '我的指令 {{@file}}', provider: 'glm', mode: 'inline', docTitleTemplate: '摘要 · {{date}}' };
  assert.deepEqual(readDigestConfig({ digest: stored }), stored, '全字段原样读出');
  assert.equal(resolveDigest({ digest: stored }), null, '运行时仍读作关闭（不跑摘要）');
});

test('readDigestConfig：字段归一与 resolveDigest 同口径，docTitleTemplate 保留原始空串', () => {
  assert.deepEqual(readDigestConfig({ digest: { enabled: true } }), {
    enabled: true, instruction: '', provider: '', mode: 'subdoc', docTitleTemplate: '',
  }, '缺省字段归一；docTitleTemplate 不回落默认（编辑器靠 placeholder 展示）');
  assert.equal(readDigestConfig({ digest: { enabled: true, provider: ' xx ' } }).provider, 'xx', 'provider 去空白');
  assert.equal(readDigestConfig({ digest: { enabled: true, mode: 'weird' } }).mode, 'subdoc', '非法 mode 归一 subdoc');
  assert.equal(readDigestConfig({ digest: { enabled: 'yes' } }).enabled, false, '非布尔 enabled 读作关');
});
