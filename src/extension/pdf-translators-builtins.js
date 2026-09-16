// Built-in PDF Translator registry (#110). Detection lives here so popup probing and translator
// selection share one ordered source of truth; direct PDF tabs remain handled by the core path.
const HTTP = new Set(['http:', 'https:']);

function fileName(url) {
  try {
    const value = new URL(url, 'https://invalid.test').pathname.split('/').filter(Boolean).pop() || null;
    return value ? decodeURIComponent(value) : null;
  } catch { return null; }
}

export function detectBuiltInPdf(pageUrl, citationPdfUrl = null) {
  try {
    const page = new URL(pageUrl);
    if (!HTTP.has(page.protocol)) return null;
    const isArxiv = page.hostname === 'arxiv.org' || page.hostname.endsWith('.arxiv.org');
    if (isArxiv) {
      const match = page.pathname.match(/^\/abs\/([^/]+)/);
      if (match?.[1]) return { url: `${page.origin}/pdf/${match[1]}`, name: `${match[1]}.pdf`, translatorID: '2b9c4f21-3c8a-4a7b-8c10-000000000001' };
    }
    if (page.hostname === 'huggingface.co') {
      const match = page.pathname.match(/^\/(datasets\/)?([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+?\.pdf)$/i);
      if (match) {
        const [, datasets = '', repo, ref, filePath] = match;
        return { url: `${page.origin}/${datasets}${repo}/resolve/${ref}/${filePath}`, name: fileName(filePath), translatorID: '2b9c4f21-3c8a-4a7b-8c10-000000000002' };
      }
    }
    if (citationPdfUrl) {
      const pdf = new URL(citationPdfUrl, page);
      if (HTTP.has(pdf.protocol)) return { url: pdf.href, name: fileName(pdf.href), translatorID: '2b9c4f21-3c8a-4a7b-8c10-000000000003' };
    }
  } catch { /* invalid page or citation URL */ }
  return null;
}

export const BUILT_IN_PDF_TRANSLATORS = Object.freeze([
  Object.freeze({ translatorID: '2b9c4f21-3c8a-4a7b-8c10-000000000001', label: 'arXiv PDF', priority: 10, target: '^https?://(?:[^/]+\\.)?arxiv\\.org/abs/', kind: 'arxiv' }),
  Object.freeze({ translatorID: '2b9c4f21-3c8a-4a7b-8c10-000000000002', label: 'Hugging Face PDF', priority: 20, target: '^https?://huggingface\\.co/', kind: 'huggingface' }),
  Object.freeze({ translatorID: '2b9c4f21-3c8a-4a7b-8c10-000000000003', label: 'citation_pdf_url', priority: 90, target: '^https?://', kind: 'citation' }),
]);

export function createBuiltInPdfTranslatorEntries() {
  return BUILT_IN_PDF_TRANSLATORS.map((metadata) => ({
    ok: true, compatibility: 'compatible', enabled: true, source: 'builtin',
    translator: {
      metadata: { ...metadata, creator: '先存飞书', version: '1', translatorType: 4, requestOrigins: [] },
      code: builtInCode(metadata.kind),
    },
  }));
}

function builtInCode(kind) {
  if (kind === 'arxiv') return `function detectWeb(document, url) { return /^https?:\\/\\/(?:[^/]+\\.)?arxiv\\.org\\/abs\\//.test(url) ? 'journalArticle' : false; }
function doWeb(document, url) { var page = new URL(url); var id = page.pathname.match(/^\\/abs\\/([^/]+)/); if (!id) return; var item = new Zotero.Item('journalArticle'); item.attachments = [{ url: page.origin + '/pdf/' + id[1], title: id[1] + '.pdf', mimeType: 'application/pdf', primary: true }]; item.complete(); }`;
  if (kind === 'huggingface') return `function detectWeb(document, url) { return /^https?:\\/\\/huggingface\\.co\\/(?:datasets\\/)?[^/]+\\/[^/]+\\/blob\\/[^/]+\\/.+\\.pdf(?:$|[?#])/.test(url) ? 'journalArticle' : false; }
function doWeb(document, url) { var page = new URL(url); var item = new Zotero.Item('journalArticle'); var resolved = page.origin + page.pathname.replace('/blob/', '/resolve/'); var name = page.pathname.split('/').pop(); item.attachments = [{ url: resolved, title: name, mimeType: 'application/pdf', primary: true }]; item.complete(); }`;
  return `function citationPdf(document) { var node = document.querySelector('meta[name="citation_pdf_url" i]'); return node && node.getAttribute('content'); }
function detectWeb(document, url) { return citationPdf(document) ? 'journalArticle' : false; }
function doWeb(document, url) { var value = citationPdf(document); if (!value) return; var item = new Zotero.Item('journalArticle'); item.attachments = [{ url: new URL(value, url).href, title: 'PDF', mimeType: 'application/pdf', primary: true }]; item.complete(); }`;
}
