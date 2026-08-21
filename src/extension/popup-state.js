// 弹窗 job 状态的纯归约逻辑。recovered 表示该 attempt 是打开弹窗时从存储恢复的旧会话：
// 旧会话的终态只作提示，不得把「保存到飞书」主按钮换成「打开文档」——用户可能正准备发起新剪藏。

export const TERMINAL_STATUSES = new Set(['succeeded', 'succeeded_with_warnings', 'failed', 'needs_attention', 'expired', 'cancelled', 'cancelled_with_document']);

export function describeJobView(job, { recovered = false } = {}) {
  if (job.status === 'succeeded' || job.status === 'succeeded_with_warnings') {
    const warning = job.status === 'succeeded_with_warnings';
    return {
      kind: warning ? 'warning' : 'success',
      message: warning ? `正文已保存；${job.warnings.length} 张图片需要注意。` : '已保存到飞书。',
      swapPrimary: !recovered,
      documentUrl: job.document?.url || null,
    };
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    return { kind: 'failure', message: job.error || '剪藏未完成，请修复后重新发起。', swapPrimary: false, documentUrl: null };
  }
  return {
    kind: 'progress',
    message: job.status === 'queued' ? '已提交，等待本地 Bridge 处理…' : '正在创建飞书文档并处理图片…',
    swapPrimary: false,
    documentUrl: null,
  };
}
