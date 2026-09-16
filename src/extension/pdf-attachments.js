// Multi-PDF budgets for one Clip Attempt. URL/PDF/primary normalization is owned by
// normalizePdfAttachments so Translator output and upload input cannot drift.
import { normalizePdfAttachments } from './pdf-translator.js';

export const PDF_ATTACHMENT_LIMITS = Object.freeze({ maxCount: 10, maxEachBytes: 100 * 1024 * 1024, maxTotalBytes: 300 * 1024 * 1024 });

export function normalizePdfCandidates(candidates, limits = PDF_ATTACHMENT_LIMITS) {
  const source = Array.isArray(candidates) ? candidates : [];
  const hadExplicitPrimary = source.some((candidate) => candidate?.primary === true);
  const normalized = normalizePdfAttachments(candidates);
  const warnings = normalized.diagnostics.map((entry) => (
    entry.code === 'DUPLICATE_ATTACHMENT' ? `已去重 PDF：${entry.url}` : entry.message
  ));
  const attachments = [];
  for (const candidate of normalized.candidates) {
    const original = source[candidate.order] || {};
    if (attachments.length >= limits.maxCount) { warnings.push(`超过 ${limits.maxCount} 个 PDF，后续附件已跳过`); continue; }
    const sizeBytes = Number.isInteger(original.sizeBytes) && original.sizeBytes > 0 ? original.sizeBytes : null;
    if (sizeBytes !== null && sizeBytes > limits.maxEachBytes) { warnings.push(`PDF 超过单文件 ${limits.maxEachBytes} 字节限制：${candidate.url}`); continue; }
    const used = attachments.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
    if (sizeBytes !== null && used + sizeBytes > limits.maxTotalBytes) { warnings.push(`PDF 超过总计 ${limits.maxTotalBytes} 字节限制：${candidate.url}`); continue; }
    attachments.push({
      id: original.id || `pdf-${attachments.length + 1}`,
      url: candidate.url,
      name: candidate.name,
      sizeBytes,
      primary: candidate.primary,
      translatorID: original.translatorID || null,
    });
  }
  let primaryIndex = attachments.findIndex((item) => item.primary);
  if (primaryIndex < 0 && attachments.length && !hadExplicitPrimary) { attachments[0].primary = true; primaryIndex = 0; }
  return { attachments: attachments.map((item, index) => ({ ...item, primary: index === primaryIndex })), primary: attachments[primaryIndex] || null, warnings };
}

export function primaryPdfForAi(result, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const primary = result?.primary || null;
  if (!primary) return { attachment: null, warning: '没有可用的主 PDF，摘要将使用纯文本' };
  if (primary.sizeBytes !== null && primary.sizeBytes > maxBytes) return { attachment: null, warning: '主 PDF 超过 AI 附件大小限制，摘要将使用纯文本' };
  return { attachment: primary, warning: null };
}
