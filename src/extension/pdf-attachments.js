// Multi-PDF candidate normalization for one Clip Attempt (#111).
export const PDF_ATTACHMENT_LIMITS = Object.freeze({ maxCount: 10, maxEachBytes: 100 * 1024 * 1024, maxTotalBytes: 300 * 1024 * 1024 });

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function normalizePdfCandidates(candidates, limits = PDF_ATTACHMENT_LIMITS) {
  const warnings = [];
  const seen = new Set();
  const attachments = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const url = normalizeUrl(candidate?.url);
    if (!url) { warnings.push('已跳过无效 PDF 地址'); continue; }
    if (seen.has(url)) { warnings.push(`已去重 PDF：${url}`); continue; }
    seen.add(url);
    if (attachments.length >= limits.maxCount) { warnings.push(`超过 ${limits.maxCount} 个 PDF，后续附件已跳过`); continue; }
    const sizeBytes = Number.isInteger(candidate?.sizeBytes) && candidate.sizeBytes > 0 ? candidate.sizeBytes : null;
    if (sizeBytes !== null && sizeBytes > limits.maxEachBytes) { warnings.push(`PDF 超过单文件 ${limits.maxEachBytes} 字节限制：${url}`); continue; }
    const used = attachments.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
    if (sizeBytes !== null && used + sizeBytes > limits.maxTotalBytes) { warnings.push(`PDF 超过总计 ${limits.maxTotalBytes} 字节限制：${url}`); continue; }
    attachments.push({
      id: candidate?.id || `pdf-${attachments.length + 1}`,
      url,
      name: typeof candidate?.name === 'string' && candidate.name ? candidate.name : null,
      sizeBytes,
      primary: candidate?.primary === true,
      translatorID: candidate?.translatorID || null,
    });
  }
  const marked = attachments.findIndex((item) => item.primary);
  const primaryIndex = marked >= 0 ? marked : 0;
  if (attachments.filter((item) => item.primary).length > 1) warnings.push('多个 PDF 标记为主文件，已使用第一个主文件');
  return { attachments: attachments.map((item, index) => ({ ...item, primary: index === primaryIndex })), primary: attachments[primaryIndex] || null, warnings };
}

export function primaryPdfForAi(result, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const primary = result?.primary || null;
  if (!primary) return { attachment: null, warning: '没有可用的主 PDF，摘要将使用纯文本' };
  if (primary.sizeBytes !== null && primary.sizeBytes > maxBytes) return { attachment: null, warning: '主 PDF 超过 AI 附件大小限制，摘要将使用纯文本' };
  return { attachment: primary, warning: null };
}
