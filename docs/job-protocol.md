# Bridge web clip job protocol

`PersistentJobStore` is the MVP seam between the localhost Bridge transport and the clip worker. It persists one record per **clip attempt** in an atomically replaced JSON file.

## Identity and idempotency

- The extension generates a fresh `attemptId` for every deliberate click.
- HTTP retries, popup reconnects and worker retries reuse that `attemptId`.
- Reusing an `attemptId` returns the existing job; reusing the same source URL with a new `attemptId` creates a new job.
- The Bridge is single-process. The store serialises mutations within that process; it is not a multi-process database.

## Worker lease and popup recovery

- `claim` moves `queued → running` and assigns a time-limited worker lease.
- `heartbeat` extends a lease only for its active worker.
- `recoverExpired` requeues a running job whose lease expired, preserving its `step` and incrementing `retryCount`.
- The popup keeps the `attemptId` in extension storage and restores UI state with `get` or filtered `list` calls after reopening.
- Statuses, steps, failure stages and cleanup outcomes use exported constants and reject unsupported values at public boundaries.

## Ambiguous create timeout

Before calling Feishu, the worker must persist `beginCreate`. A crash with this barrier active recovers into `reconciling`, never directly into another create call. An explicit timeout then uses `markCreateAmbiguous`, which also moves the job to `reconciling`. Neither lease recovery nor a new worker may retry document creation from that state. The Bridge must first query the target Wiki using its attempt marker:

- document found → `resolveAmbiguousCreate` records it and queues `write_body`;
- confirmed absent → it queues `create_document` again;
- reconciliation itself expires → `needs_attention`.

This query runs in the Bridge's sweep (`ClipExecutor.reconcile()`): once at startup and then on a periodic interval (`sweepIntervalMs`, default 10 minutes), alongside `recoverExpired`. Only a document whose body carries the attempt marker is adopted; a same-titled document without the marker cannot be proven ours and is treated as absent.

## Cancellation

- Before a document exists → `cancelled`.
- After a document exists → `cancelled_with_document`, preserving its URL.
- During ambiguous creation → `cancel_pending_reconciliation`; the final cancelled state is chosen only after reconciliation.

## Failure and orphan policy

- Create/body failure without a document → `failed`.
- Body failure after creation → the executor attempts to delete only the document created by this attempt, then passes the cleanup result to `fail`.
- Confirmed deletion → `failed` with no document reference.
- Failed or skipped deletion → `needs_attention`, preserving the document URL and cleanup error.
- Image-only failure → `succeeded_with_warnings`; useful text and successful images remain available.
- A stale queued job without a document → `expired`; a stale queued job with a document → `needs_attention`.

The store never calls Feishu itself. This keeps deletion credentials and API retries in the Bridge executor while making the resulting state transition deterministic and testable. The concrete HTTP endpoints, extension-side `attemptId` storage and Feishu deletion adapter belong to the later Bridge/extension implementation ticket; this ticket defines and tests the state contract they must follow.

## Dual jobs per attempt (#60/#65)

One clip attempt (`attemptId`) may carry two jobs: a `clip` job (the wiki document pipeline above) and a `pdf` job (downloading the page's main PDF and uploading it to Drive). The store keys jobs by `(attemptId, kind)`:

- `submit({ attemptId, kind: 'pdf', pdfSource, title, folderToken })` requires a url-type `pdfSource` (credential-free http(s); the `bytes` variant is #61). `title` is the extension's rendered title, used to name the uploaded file. `folderToken` (#66) is the picker-selected Drive folder; `null` means the Drive root. A failed-job retry takes the latest `folderToken` (the user may have re-selected the folder in the popup). Job files written before #66 have no `folderToken`; pdf jobs are read with `null` (root).
- Idempotent re-submit matches on `(attemptId, kind)`. A `failed` pdf job re-submitted with the same key is reset to `queued` and re-run (`retried: true`) — this backs the popup's 重试 PDF action. Clip jobs keep the old semantics: a terminal clip job re-submitted with the same key is returned unchanged.
- `get(attemptId)` returns all jobs of the attempt (an array, possibly empty); `get(attemptId, kind)` returns the single job or `null`. `claim`/`cancel`/`complete`/`fail` take the kind as a trailing argument (default `clip`).
- Job files written before the dual-job model have no `kind`; they are read as `clip` (read-side migration, storage format unchanged).

The pdf job uses a minimal status set (`queued/running/succeeded/failed/cancelled/expired`) — no `reconciling`, no `needs_attention`, no orphan cleanup. Upload ambiguity (timeout with unknown server outcome) is treated as plain failure: Drive permits same-name files to coexist and orphan uploads are harmless, so the pdf path never reconciles. `complete` for a pdf job requires the uploaded artifact (`{ fileToken, url }`) as its `document`; `fail` always lands on `failed` with stage `pdf` (download and upload are not distinguished). The popup aggregates both jobs of an attempt into a single view (see `describeAttemptView` in `src/extension/popup-state.js`).

## PDF-tab submissions (#67)

When the tab itself is a PDF (the browser's built-in viewer), `POST /v1/jobs` accepts a pdf-only body — `{ attemptId, pdfSource, pdfFolderToken?, title? }` with no `snapshot`/`destination` — and queues exactly one `pdf` job. Detection runs in the extension: a `chrome.scripting` probe reads `document.contentType === 'application/pdf'` (the Zotero signal; zero permission increment over `activeTab` + `scripting`), falling back to a `\.pdf$` suffix test on `tab.url` (ignoring query/hash) only when injection fails. The pdf job's `sourceUrl` is the PDF URL itself, so the popup's same-page recovery (`isJobForPage`) works unchanged. The popup renders a single panel for this page form (no preset chips, no preview, no clip job) and the save button re-submits the same `attemptId` after a failure, reusing the failed-pdf retry semantics above. Credential-carrying PDF URLs are out of scope here (#68): the bytes travel via the Bridge's url-type download, which only fits public URLs.
