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

function detectWeb(document, url) {
  return /^https?:\/\/huggingface\.co\/(?:datasets\/)?[^/]+\/[^/]+\/blob\/[^/]+\/.+\.pdf(?:$|[?#])/.test(url) ? 'journalArticle' : false;
}

function doWeb(document, url) {
  var page = new URL(url);
  var item = new Zotero.Item('journalArticle');
  var resolved = page.origin + page.pathname.replace('/blob/', '/resolve/');
  var name = page.pathname.split('/').pop();
  item.attachments = [{ url: resolved, title: name, mimeType: 'application/pdf', primary: true }];
  item.complete();
}
