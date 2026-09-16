// Built-in PDF Translator registry (#110). Each site rule is shipped as an ordinary Zotero-style
// .js file and goes through the same parser as a community import.
import { parsePdfTranslatorFile } from './pdf-translator.js';
import { PAPER_SITES } from './paper-sites.js';

export const BUILT_IN_PDF_TRANSLATORS = Object.freeze([
  ...PAPER_SITES.map(({ label, path }) => Object.freeze({ label, path })),
  Object.freeze({ label: 'citation_pdf_url', path: './pdf-translators/citation-pdf-url.js' }),
]);

export async function createBuiltInPdfTranslatorEntries({ readText } = {}) {
  const load = readText || (async (path) => {
    const response = await fetch(new URL(path, import.meta.url));
    if (!response.ok) throw new Error(`无法加载内置 PDF Translator：${path}`);
    return response.text();
  });
  return Promise.all(BUILT_IN_PDF_TRANSLATORS.map(async ({ path }) => ({
    ...parsePdfTranslatorFile(await load(path)),
    filePath: `扩展目录/${path.replace(/^\.\//, '')}`,
    enabled: true,
    confirmed: true,
    source: 'builtin',
  })));
}
