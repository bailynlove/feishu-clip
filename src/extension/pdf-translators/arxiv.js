{
  "translatorID": "2b9c4f21-3c8a-4a7b-8c10-000000000001",
  "label": "arXiv PDF",
  "creator": "先存飞书",
  "target": "^https?://(?:[^/]+\\.)?arxiv\\.org/abs/",
  "priority": 10,
  "translatorType": 4,
  "version": "1",
  "lastUpdated": "2026-09-16 00:00:00"
}

function detectWeb(document, url) {
  return /^https?:\/\/(?:[^/]+\.)?arxiv\.org\/abs\//.test(url) ? 'journalArticle' : false;
}

function doWeb(document, url) {
  var page = new URL(url);
  var id = page.pathname.match(/^\/abs\/([^/]+)/);
  if (!id) return;
  var item = new Zotero.Item('journalArticle');
  item.attachments = [{ url: page.origin + '/pdf/' + id[1], title: id[1] + '.pdf', mimeType: 'application/pdf', primary: true }];
  item.complete();
}
