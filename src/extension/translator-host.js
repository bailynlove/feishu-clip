import { createIframeSandbox, createPdfTranslatorRunner } from './pdf-translator-runtime.js';

async function run({ translators, page }) {
  const sandbox = createIframeSandbox();
  try {
    const runner = createPdfTranslatorRunner({ sandboxFactory: sandbox, fetchImpl: globalThis.fetch });
    const result = await runner.runDetectionChain({ translators, page });
    const translatorID = result.translator?.translator?.metadata?.translatorID ?? null;
    return {
      attachments: result.attachments.map((attachment) => ({ ...attachment, translatorID })),
      diagnostics: result.diagnostics,
      translatorID,
    };
  } finally {
    sandbox.dispose();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'pdf-translator-host' || message.type !== 'RUN_PDF_TRANSLATORS') return false;
  run(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: { code: error.code || 'TRANSLATOR_FAILED', message: error.message } }),
  );
  return true;
});
