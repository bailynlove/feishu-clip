{
  "translatorID": "b12b8f6a-3d43-4f7d-88be-1481640bd8f1",
  "label": "Unsupported Example",
  "creator": "Feishu Clip tests",
  "target": "^https://unsupported\\.example/",
  "priority": 100,
  "translatorType": 4,
  "browserSupport": "gcsibv",
  "lastUpdated": "2026-09-16 12:00:00"
}

function detectWeb(document, url) {
  return 'multiple';
}

async function doWeb(document, url) {
  // These strings must not affect compatibility: "Zotero.Search" and 'Zotero.Items'.
  const selected = await Zotero.selectItems({ one: 'One paper' });
  const nested = Zotero.loadTranslator('import');
  nested.setTranslator('32d59d2d-b65a-4da4-b0a3-bf4c0f6c79f4');
  const search = new Zotero.Search();
  return selected;
}
