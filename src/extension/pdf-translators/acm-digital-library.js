{
  "translatorID": "c819b9c1-c8c7-59ef-b568-7e8e468b5237",
  "label": "ACM Digital Library PDF",
  "creator": "先存飞书（参考 Zotero translators）",
  "target": "^https?://dl\\.acm\\.org/",
  "priority": 26,
  "translatorType": 4,
  "version": "1",
  "lastUpdated": "2026-09-16 00:00:00"
}

function absolute(value, url) { if (!value) return null; try { return new URL(value, url).href; } catch (error) { return null; } }
function meta(document, names) { for (var i = 0; i < names.length; i += 1) { var node = document.querySelector('meta[name="' + names[i] + '" i], meta[property="' + names[i] + '" i]'); if (node && node.getAttribute('content')) return node.getAttribute('content'); } return null; }
function firstLink(document, url, selectors) { for (var i = 0; i < selectors.length; i += 1) { var nodes = document.querySelectorAll(selectors[i]); for (var j = 0; j < nodes.length; j += 1) { var value = nodes[j].getAttribute('href'); if (value) return absolute(value, url); } } return null; }
function genericPdf(document, url) { var value = meta(document, ['citation_pdf_url', 'eprints.document_url', 'wkhealth_pdf_url']); if (value) return absolute(value, url); return firstLink(document, url, ['link[type="application/pdf"]', 'a[type="application/pdf"]', 'a[title*="PDF" i][href]', 'a[href$=".pdf" i]', 'a[href*="/pdf/" i]']); }
function sitePdf(document, url) { var doi = meta(document, ['citation_doi']); if (!doi) { var match = new URL(url).pathname.match(/\/doi\/(?:abs\/|full\/)?(10\..+)/); doi = match && match[1]; } return doi ? new URL('/doi/pdf/' + doi + '?download=true', url).href : null; }
function findPdf(document, url) { return sitePdf(document, url) || genericPdf(document, url); }
function detectWeb(document, url) { return findPdf(document, url) ? 'journalArticle' : false; }
function doWeb(document, url) { var pdf = findPdf(document, url); if (!pdf) return; var item = new Zotero.Item('journalArticle'); item.attachments = [{ url: pdf, title: 'Full Text PDF', mimeType: 'application/pdf', primary: true }]; item.complete(); }
