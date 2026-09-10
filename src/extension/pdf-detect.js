// 弹窗打开时的主 PDF 轻量探测（#65）：只读 location 与 citation_pdf_url meta，
// 再尽力发一次 HEAD 拿文件大小——拿不到（CORS/服务器不支持）就显示「未知大小」，不阻塞主流程。
// 识别规则与 extractor.js 的 detectMainPdf 是同一份（两处均为独立注入的经典脚本，
// 无法共享模块，规则修改须两边同步）；不跑正文提取、不做全量 PDF 链接扫描（#58 结论）。
(async () => {
  function detectMainPdf(pageUrl, citationPdfUrl) {
    try {
      const page = new URL(pageUrl);
      const isArxiv = page.hostname === 'arxiv.org' || page.hostname.endsWith('.arxiv.org');
      if (isArxiv) {
        const match = page.pathname.match(/^\/abs\/([^/]+)/);
        if (match && match[1]) return { url: `${page.origin}/pdf/${match[1]}`, name: `${match[1]}.pdf` };
      }
      if (citationPdfUrl) {
        const pdf = new URL(citationPdfUrl, page);
        if (pdf.protocol === 'http:' || pdf.protocol === 'https:') {
          let name = pdf.pathname.split('/').filter(Boolean).pop() || null;
          try { name = name ? decodeURIComponent(name) : null; } catch { /* 保留未解码原名 */ }
          return { url: pdf.href, name };
        }
      }
    } catch { /* 非法输入一律按未识别处理 */ }
    return null;
  }

  try {
    const citationPdf = document.querySelector('meta[name="citation_pdf_url"]')?.getAttribute('content') ?? null;
    const pdf = detectMainPdf(location.href, citationPdf);
    if (!pdf) return { pdf: null };
    // HEAD 取大小是 #59 定稿原型（prototype/popup-pdf-59 分支 variant-a）发现性入口的既定规格
    // ——入口本就带大小展示，非 scope creep；拿不到（CORS/服务器不支持）显示「未知大小」
    let sizeBytes = null;
    try {
      const response = await fetch(pdf.url, { method: 'HEAD', credentials: 'same-origin' });
      const length = Number(response.headers.get('content-length'));
      if (response.ok && Number.isFinite(length) && length > 0) sizeBytes = length;
    } catch { sizeBytes = null; }
    return { pdf: { ...pdf, sizeBytes } };
  } catch {
    return { pdf: null };
  }
})()
