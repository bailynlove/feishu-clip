# PDF Translator runtime

Community PDF translators execute in `src/extension/translator-sandbox.html`, an MV3 sandbox iframe
with only `allow-scripts`. The iframe receives a serialized page snapshot and translator source; it
does not receive the extension DOM, storage, cookies, or extension APIs. Translator requests are
posted back as RPC messages and are performed by the extension host.

`createPdfTranslatorNetworkPolicy()` is the host-side gate. `detectWeb` cannot make requests;
`doWeb` is limited to eight requests, 5 MiB per response, 20 MiB total, and ten redirect hops.
Requests may use the page origin and translator-declared `requestOrigins`. Cross-origin requests use
`credentials: omit` and reject authentication headers. Every redirect is checked against the same
origin allowlist.

`createPdfTranslatorRunner()` selects enabled compatible translators by target and priority, applies
the phase timeout (1 second for detection and 15 seconds for extraction), and records a warning before
falling through to the next translator. A timed-out run disposes the sandbox. Extension-page hosts
can use `createIframeSandbox()`; a service worker should host that adapter in an offscreen document.
