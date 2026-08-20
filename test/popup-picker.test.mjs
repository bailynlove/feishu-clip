import assert from 'node:assert/strict';
import test from 'node:test';
import { createPopupPicker } from '../src/extension/popup-picker.js';

const spaces = [
  { spaceId: 's1', name: 'Project', spaceType: 'team' },
  { spaceId: 's2', name: 'Area', spaceType: 'team' },
];

function fakeDeps({ failValidation = () => false } = {}) {
  const validated = [];
  return {
    validated,
    deps: {
      listSpaces: async () => ({ spaces, hasMore: false, nextPageToken: null }),
      listNodes: async ({ spaceId }) => ({
        nodes: [{ nodeToken: 'n1', spaceId, title: '收集箱', objType: 'docx', hasChildren: false }],
        hasMore: false,
        nextPageToken: null,
      }),
      validateDestination: async (destination) => {
        validated.push(destination);
        const error = failValidation();
        if (error) throw error;
        return { destination: { kind: destination.kind, nodeToken: destination.nodeToken, spaceId: destination.spaceId, title: '已验证标题', objType: 'docx' } };
      },
    },
  };
}

test('confirming a node target only validates and never persists', async () => {
  const { deps, validated } = fakeDeps();
  const picker = createPopupPicker(deps);
  // 依赖里根本没有持久化入口：确认路径在构造上就不可能写默认目标
  assert.equal('saveDestination' in deps, false);

  await picker.start();
  await picker.openSpace(spaces[0]);
  picker.select({ nodeToken: 'n1', spaceId: 's1', title: '收集箱' });
  const confirmed = await picker.saveSelection();
  assert.equal(confirmed.title, '已验证标题');
  assert.deepEqual(validated, [{ kind: 'node', nodeToken: 'n1', spaceId: 's1', title: '收集箱', path: ['Project'] }]);
  assert.deepEqual(confirmed.path, ['Project']);
});

test('confirming a space target validates the space root', async () => {
  const { deps, validated } = fakeDeps();
  const picker = createPopupPicker(deps);
  await picker.start();
  picker.selectSpace(spaces[1]);
  const confirmed = await picker.saveSelection();
  assert.equal(confirmed.spaceId, 's2');
  assert.deepEqual(validated, [{ kind: 'space', spaceId: 's2', title: 'Area', path: ['Area'] }]);
});

test('each popup open starts fresh with no leftover selection', async () => {
  const { deps } = fakeDeps();
  const first = createPopupPicker(deps);
  await first.start();
  first.selectSpace(spaces[0]);
  assert.equal(first.getState().selectedSpaceId, 's1');

  const reopened = createPopupPicker(deps);
  await reopened.start();
  const state = reopened.getState();
  assert.equal(state.selectedSpaceId, null);
  assert.equal(state.view, 'spaces');
});

test('invalidated target requires reselection instead of silent fallback', async () => {
  const invalid = Object.assign(new Error('节点不存在或无权访问'), { code: 'INVALID_TARGET' });
  let broken = true;
  const { deps, validated } = fakeDeps({ failValidation: () => (broken ? invalid : null) });
  const picker = createPopupPicker(deps);
  await picker.start();
  picker.selectSpace(spaces[0]);

  assert.equal(await picker.saveSelection(), null, 'failed validation must not produce a destination');
  assert.equal(picker.getState().error.kind, 'failed');
  assert.equal(validated.length, 1);

  // 修复后可重新选择并成功；失败不会产生任何兜底目标
  broken = false;
  picker.selectSpace(spaces[1]);
  const confirmed = await picker.saveSelection();
  assert.equal(confirmed.spaceId, 's2');
});
