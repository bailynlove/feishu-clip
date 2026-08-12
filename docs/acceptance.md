# MVP acceptance evidence

Date: 2026-08-12 (Asia/Shanghai)

## Automated

- `npm test`: 21 tests pass.
- `npm run check`: Bridge and MV3 scripts parse successfully.
- Coverage includes pairing replacement, exact extension-origin binding, the MV3 service-worker missing-Origin seam, CORS conflict rejection, persistent job recovery, ambiguous create safety, partial success, SSRF and DNS rebinding rejection, image limits, HTTP job recovery, and LaunchAgent generation.

## Real macOS and Chrome

- Installed at `~/Library/Application Support/FeishuClip` with root mode `0700` and config, pairing, and plist mode `0600`.
- Per-user LaunchAgent `com.feishu-clip.bridge` is loaded and binds only `127.0.0.1:38479`.
- Unpacked extension ID: `hfibogpefndpdegdkcmpogcpphlihgfj`.
- Dynamic pairing and an existing Wiki parent destination were configured through the extension options page.
- The production popup reported `Bridge 0.1.0 · 飞书已登录`.

## Real web clip

Source: <https://www.w3.org/standards/>

Created document: <<redacted-feishu-doc>>

The extension extracted the live page, submitted a persistent Bridge job, recovered the result in the popup, and opened the generated document. A `docs +fetch` readback confirmed the title, source metadata, headings, paragraphs, emphasis, links, and lists. The page's only image candidate was SVG, which is outside the accepted JPEG/PNG/GIF/WebP policy; the job therefore correctly returned `succeeded_with_warnings` and retained a normalized original-image link.

A separate production Bridge acceptance with a public PNG returned `succeeded` with no warnings and read back an embedded Feishu image block: <<redacted-feishu-doc>>.

## Remaining release check

The LaunchAgent has passed install, KeepAlive recovery, persisted-plist bootstrap, upgrade, and uninstall testing. A real macOS logout/login remains the final release-environment check because it necessarily interrupts the active user session.
