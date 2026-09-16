// Persistent user Translator files (#109). The options page stores validated source snapshots so
// changing or deleting the original local file never changes the active extension copy.
export const PDF_TRANSLATORS_STORAGE_KEY = 'pdfTranslators';

export function normalizePdfTranslatorEntries(raw) {
  return (Array.isArray(raw) ? raw : []).filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      ...entry,
      source: 'imported',
      enabled: entry.enabled !== false,
      confirmed: entry.confirmed === true,
      translator: entry.translator && {
        metadata: { ...entry.translator.metadata },
        code: String(entry.translator.code || ''),
        source: String(entry.translator.source || ''),
      },
      diagnostics: Array.isArray(entry.diagnostics) ? entry.diagnostics : [],
    }))
    .filter((entry) => entry.translator?.metadata?.translatorID);
}

export function upsertPdfTranslator(entries, entry) {
  const current = normalizePdfTranslatorEntries(entries);
  const id = entry?.translator?.metadata?.translatorID;
  if (!id) return current;
  const index = current.findIndex((candidate) => candidate.translator.metadata.translatorID === id);
  const next = { ...entry, source: 'imported', enabled: entry.enabled !== false, confirmed: entry.confirmed === true };
  if (index < 0) return [...current, next];
  const result = current.slice();
  result[index] = next;
  return result;
}

export function removePdfTranslator(entries, translatorID) {
  return normalizePdfTranslatorEntries(entries).filter((entry) => entry.translator.metadata.translatorID !== translatorID);
}

export function setPdfTranslatorEnabled(entries, translatorID, enabled) {
  return normalizePdfTranslatorEntries(entries).map((entry) => entry.translator.metadata.translatorID === translatorID ? { ...entry, enabled: Boolean(enabled) } : entry);
}

export function pdfTranslatorView(entry) {
  const metadata = entry?.translator?.metadata || {};
  return {
    label: metadata.label || '未命名 Translator', creator: metadata.creator || '未知作者',
    version: metadata.version || metadata.lastUpdated || '未知版本', translatorID: metadata.translatorID || '',
    target: metadata.target || '', priority: metadata.priority ?? '—', enabled: entry?.enabled !== false,
    compatibility: entry?.compatibility || 'incompatible', requestOrigins: metadata.requestOrigins || [],
    diagnostics: entry?.diagnostics || [],
  };
}
