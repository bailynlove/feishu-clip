import assert from 'node:assert/strict';
import test from 'node:test';
import { describeJobView } from '../src/extension/popup-state.js';

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
