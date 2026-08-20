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

## Real logout/login release check

Completed on 2026-08-18 (Asia/Shanghai) after the user performed a real macOS
logout and login. The persisted plist from 2026-08-12 was loaded automatically
into the new `gui/501` session without running the installer or manually calling
`launchctl bootstrap`:

- `launchctl print gui/501/com.feishu-clip.bridge` reported `state = running`,
  `runs = 1`, PID `790`, `last exit code = never exited`, and the expected
  `runatload | keepalive` properties.
- The process start time was 2026-08-18 15:59:25 and its parent PID was `1`,
  confirming that it belonged to the login-session LaunchAgent rather than the
  previous interactive shell.
- The process listened only on `127.0.0.1:38479`. The application root remained
  mode `0700`; the plist, Bridge configuration, and pairing state remained mode
  `0600`.
- The authenticated Bridge health endpoint returned HTTP 200, version `0.1.0`,
  PID `790`, address `127.0.0.1`, and `larkAuth.ready = true`. A direct
  `lark-cli auth status --json --verify` check reported the user identity ready
  with a valid token; no Keychain downgrade was used.

The first health query immediately after reconnecting to the desktop session
reported `larkAuth.ready = false`; verifying the existing user token refreshed
the CLI state, after which the same already-running LaunchAgent returned
`larkAuth.ready = true`. No reinstall, re-pairing, plist reload, Bridge restart,
or new OAuth login was required.

This completes the final release-environment check. The LaunchAgent has now
passed installation, KeepAlive recovery, persisted-plist bootstrap, upgrade,
uninstall, and a real logout/login cycle.

## Visual default-target picker (#20)

Date: 2026-08-20 (Asia/Shanghai)

## Automated

- `npm test`: 32 tests pass, including `test/targets.test.mjs` (route auth, query validation, pagination passthrough, error-code mapping, `LarkClient` argv and field whitelist) and `test/target-picker.test.mjs` (space list and pagination, breadcrumb navigation and back, node pagination, select-and-save summary, failed save keeps the previous default, manual fallback shares validate-and-save semantics, offline/unpaired/auth/forbidden states with retry).
- `npm run check`: all Bridge and MV3 scripts, including the new `target-picker.js` module, parse successfully.

## Real Feishu account via production Bridge path

`node scripts/accept-targets.mjs` starts the production Bridge with the real `lark-cli` (v1.0.84), completes dynamic pairing, and exercises the new read-only routes against the real account:

- `/v1/status` reported `larkAuth.ready = true`.
- `/v1/targets/spaces?limit=3` returned page 1 (`Project`, `Area`) with `hasMore = true`; following `nextPageToken` returned page 2 (3 more spaces) with no overlap.
- `/v1/targets/nodes?spaceId=<Project>&limit=5` returned root nodes (`Homepage`, `把代码截图丢给大模型 居然可以省 token`, `PiXEL`, `找工作`) with `objType`/`hasChildren` metadata and `hasMore = true`.
- `/v1/destinations/validate` without a node token correctly fails.

Remaining manual acceptance: the Chrome options-page click-through ("选择默认目标 → 剪藏网页") requires loading the updated unpacked extension (`npm run install:mac` refreshes the installed copy) and is not driven from the CLI.

## Space-root destinations (#22)

Date: 2026-08-20 (Asia/Shanghai)

### Automated

- `npm test`: 36 tests pass, adding space-destination validation, the two-step create path (`wiki +node-create` then `docs +update --command append`), job-route input rules, and picker space selection (visual and manual).
- `npm run check` passes.

### Real Feishu account

`node scripts/accept-space-target.mjs` paired against the production Bridge path, validated the `Area` space as a destination, and submitted a real clip job with `kind: 'space'`:

- Created document: <<redacted-feishu-doc>>
- A root-level `wiki +node-list` readback confirmed the document at the space root with the page title preserved as the node title.

Note: `docs +update --command overwrite` promotes the body's first H1 to the document title; the space path therefore uses `--command append` against the empty node (verified with a probe node in the same space).

## In-popup one-off target picker (#21)

Date: 2026-08-20 (Asia/Shanghai)

### Automated

- `npm test`: 41 tests pass, adding `test/popup-picker.test.mjs`: confirm only validates (no persistence path exists by construction), space-root confirm, fresh state on each popup open, invalidated target requires reselection with no silent fallback, and cancel mid-navigation never touches the persisted default.
- `npm run check` passes with the new `picker-view.js` / `popup-picker.js` modules.

### Manual (pending)

The following remain for a real Chrome pass with the reloaded unpacked extension: picker layout within popup size (breadcrumbs, back, load-more, error states), switching one clip between two different real Feishu parent documents, and reopening the popup reverting to the persisted default target.
