{
  "translatorID": "2b9c4f21-3c8a-4a7b-8c10-000000000002",
  "label": "Hugging Face PDF",
  "creator": "先存飞书",
  "target": "^https?://huggingface\\.co/",
  "priority": 20,
  "translatorType": 4,
  "version": "1",
  "lastUpdated": "2026-09-16 00:00:00"
}

function findPdf(document, url) {
  var page = new URL(url);
  var paper = page.pathname.match(/^\/papers\/([^/]+)/);
  if (paper) return 'https://arxiv.org/pdf/' + paper[1];
  if (/^\/(?:datasets\/)?[^/]+\/[^/]+\/blob\/[^/]+\/.+\.pdf$/i.test(page.pathname)) {
    return page.origin + page.pathname.replace('/blob/', '/resolve/');
  }
  var meta = document.querySelector('meta[name="citation_pdf_url" i]');
  if (meta && meta.getAttribute('content')) return new URL(meta.getAttribute('content'), url).href;
  return null;
}

function detectWeb(document, url) {
  return findPdf(document, url) ? 'journalArticle' : false;
}

function doWeb(document, url) {
  var resolved = findPdf(document, url);
  if (!resolved) return;
  var item = new Zotero.Item('journalArticle');
  var name = new URL(resolved).pathname.split('/').pop() || 'paper.pdf';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  item.attachments = [{ url: resolved, title: name, mimeType: 'application/pdf', primary: true }];
  item.complete();
}
