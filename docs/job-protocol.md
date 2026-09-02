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
