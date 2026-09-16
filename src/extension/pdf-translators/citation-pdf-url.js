{
  "translatorID": "2b9c4f21-3c8a-4a7b-8c10-000000000003",
  "label": "citation_pdf_url",
  "creator": "先存飞书",
  "target": "^https?://",
  "priority": 90,
  "translatorType": 4,
  "version": "1",
  "lastUpdated": "2026-09-16 00:00:00"
}

function citationPdf(document) {
  var node = document.querySelector('meta[name="citation_pdf_url" i]');
  return node && node.getAttribute('content');
}

function detectWeb(document, url) {
  return citationPdf(document) ? 'journalArticle' : false;
}

function doWeb(document, url) {
  var value = citationPdf(document);
  if (!value) return;
  var item = new Zotero.Item('journalArticle');
  item.attachments = [{ url: new URL(value, url).href, title: 'PDF', mimeType: 'application/pdf', primary: true }];
  item.complete();
}
