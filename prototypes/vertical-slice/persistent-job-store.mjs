import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_STORE = Object.freeze({ version: 1, jobs: [] });

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  RECONCILING: 'reconciling',
  CANCEL_PENDING_RECONCILIATION: 'cancel_pending_reconciliation',
  SUCCEEDED: 'succeeded',
  SUCCEEDED_WITH_WARNINGS: 'succeeded_with_warnings',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  CANCELLED_WITH_DOCUMENT: 'cancelled_with_document',
  NEEDS_ATTENTION: 'needs_attention',
  EXPIRED: 'expired',
});

export const JOB_STEP = Object.freeze({
  CREATE_DOCUMENT: 'create_document',
  WRITE_BODY: 'write_body',
  DONE: 'done',
});

export const FAILURE_STAGE = Object.freeze({
  CREATE_DOCUMENT: 'create_document',
  BODY: 'body',
  IMAGES: 'images',
});

export const CLEANUP_STATUS = Object.freeze({
  DELETED: 'deleted',
  FAILED: 'failed',
  NOT_ATTEMPTED: 'not_attempted',
  SKIPPED: 'skipped',
});

const JOB_STATUSES = new Set(Object.values(JOB_STATUS));
const FAILURE_STAGES = new Set(Object.values(FAILURE_STAGE));
const CLEANUP_STATUSES = new Set(Object.values(CLEANUP_STATUS));

function assertDocument(document) {
  if (!document?.documentId || !document?.url) {
    throw new TypeError('documentId and url are required');
  }
}

export class PersistentJobStore {
  #filePath;
  #now;
  #createJobId;
  #leaseMs;
  #jobTtlMs;
  #tail = Promise.resolve();

  constructor({
    filePath,
    now = () => Date.now(),
    createJobId = () => randomUUID(),
    leaseMs = 60_000,
    jobTtlMs = 24 * 60 * 60 * 1_000,
  }) {
    if (!filePath) throw new TypeError('filePath is required');
    this.#filePath = filePath;
    this.#now = now;
    this.#createJobId = createJobId;
    this.#leaseMs = leaseMs;
    this.#jobTtlMs = jobTtlMs;
  }

  async submit({ attemptId, sourceUrl }) {
    if (!attemptId || !sourceUrl) throw new TypeError('attemptId and sourceUrl are required');

    return this.#mutate(async (data) => {
      const existing = data.jobs.find((job) => job.attemptId === attemptId);
      if (existing) {
        if (existing.sourceUrl !== sourceUrl) {
          throw new Error(`attemptId ${attemptId} is already bound to another source URL`);
        }
        return { result: { created: false, job: structuredClone(existing) }, changed: false };
      }

      const timestamp = this.#now();
      const job = {
        jobId: this.#createJobId(),
        attemptId,
        sourceUrl,
        status: JOB_STATUS.QUEUED,
        step: JOB_STEP.CREATE_DOCUMENT,
        document: null,
        warnings: [],
        error: null,
        cleanup: null,
        retryCount: 0,
        workerId: null,
        leaseExpiresAt: null,
        createInFlight: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.jobs.push(job);
      return { result: { created: true, job: structuredClone(job) }, changed: true };
    });
  }

  async get(attemptId) {
    const data = await this.#read();
    const job = data.jobs.find((candidate) => candidate.attemptId === attemptId);
    return job ? structuredClone(job) : null;
  }

  async list({ statuses } = {}) {
    if (statuses) {
      for (const status of statuses) {
        if (!JOB_STATUSES.has(status)) throw new TypeError(`Unknown job status: ${status}`);
      }
    }
    const data = await this.#read();
    const jobs = statuses
      ? data.jobs.filter((job) => statuses.includes(job.status))
      : data.jobs;
    return structuredClone(jobs);
  }

  async claim(attemptId, workerId) {
    if (!workerId) throw new TypeError('workerId is required');
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      if (job.status !== JOB_STATUS.QUEUED) throw new Error(`Cannot claim job in ${job.status} state`);
      job.status = JOB_STATUS.RUNNING;
      job.workerId = workerId;
      job.leaseExpiresAt = this.#now() + this.#leaseMs;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  async heartbeat(attemptId, workerId) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      if (job.status !== JOB_STATUS.RUNNING || job.workerId !== workerId) {
        throw new Error('Only the active worker can heartbeat a running job');
      }
      job.leaseExpiresAt = this.#now() + this.#leaseMs;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  async beginCreate(attemptId, workerId) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      this.#assertActiveWorker(job, workerId);
      if (job.step !== JOB_STEP.CREATE_DOCUMENT) throw new Error(`Cannot create a document during ${job.step}`);
      job.createInFlight = true;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  async markCreateAmbiguous(attemptId, workerId) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      this.#assertActiveWorker(job, workerId);
      this.#assertCreateInFlight(job);
      const timestamp = this.#now();
      job.status = JOB_STATUS.RECONCILING;
      job.workerId = null;
      job.leaseExpiresAt = null;
      job.ambiguousSince = timestamp;
      job.createInFlight = false;
      job.updatedAt = timestamp;
      return { result: structuredClone(job), changed: true };
    });
  }

  async resolveAmbiguousCreate(attemptId, { document }) {
    if (document !== null) assertDocument(document);
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      const cancellationPending = job.status === JOB_STATUS.CANCEL_PENDING_RECONCILIATION;
      if (job.status !== JOB_STATUS.RECONCILING && !cancellationPending) {
        throw new Error(`Cannot reconcile job in ${job.status} state`);
      }
      job.document = document ? structuredClone(document) : null;
      if (cancellationPending) {
        job.status = document ? JOB_STATUS.CANCELLED_WITH_DOCUMENT : JOB_STATUS.CANCELLED;
        job.step = JOB_STEP.DONE;
      } else {
        job.status = JOB_STATUS.QUEUED;
        job.step = document ? JOB_STEP.WRITE_BODY : JOB_STEP.CREATE_DOCUMENT;
      }
      job.ambiguousSince = null;
      job.createInFlight = false;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  async recordDocument(attemptId, workerId, document) {
    assertDocument(document);
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      this.#assertActiveWorker(job, workerId);
      this.#assertCreateInFlight(job);
      job.document = structuredClone(document);
      job.step = JOB_STEP.WRITE_BODY;
      job.createInFlight = false;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  async cancel(attemptId) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      if (job.status === JOB_STATUS.CANCELLED || job.status === JOB_STATUS.CANCELLED_WITH_DOCUMENT) {
        return { result: structuredClone(job), changed: false };
      }
      if (job.status === JOB_STATUS.RECONCILING || job.createInFlight) {
        const timestamp = this.#now();
        job.status = JOB_STATUS.CANCEL_PENDING_RECONCILIATION;
        job.createInFlight = false;
        job.ambiguousSince ??= timestamp;
        this.#releaseLease(job);
        job.updatedAt = timestamp;
        return { result: structuredClone(job), changed: true };
      }
      if (job.status !== JOB_STATUS.QUEUED && job.status !== JOB_STATUS.RUNNING) {
        throw new Error(`Cannot cancel job in ${job.status} state`);
      }
      job.status = job.document ? JOB_STATUS.CANCELLED_WITH_DOCUMENT : JOB_STATUS.CANCELLED;
      job.workerId = null;
      job.leaseExpiresAt = null;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  async complete(attemptId, workerId, { warnings = [] } = {}) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      this.#assertActiveWorker(job, workerId);
      if (!job.document) throw new Error('Cannot complete a clip attempt without a document');
      job.status = warnings.length > 0 ? JOB_STATUS.SUCCEEDED_WITH_WARNINGS : JOB_STATUS.SUCCEEDED;
      job.step = JOB_STEP.DONE;
      job.warnings = [...warnings];
      this.#releaseLease(job);
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  async fail(attemptId, workerId, { stage, error, cleanup = null }) {
    if (!stage || !error) throw new TypeError('stage and error are required');
    if (!FAILURE_STAGES.has(stage)) throw new TypeError(`Unknown failure stage: ${stage}`);
    if (cleanup && !CLEANUP_STATUSES.has(cleanup.status)) {
      throw new TypeError(`Unknown cleanup status: ${cleanup.status}`);
    }
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      this.#assertActiveWorker(job, workerId);
      job.error = error;
      job.step = JOB_STEP.DONE;

      if (stage === FAILURE_STAGE.IMAGES && job.document) {
        job.status = JOB_STATUS.SUCCEEDED_WITH_WARNINGS;
        job.warnings = [error];
      } else if (!job.document) {
        job.status = JOB_STATUS.FAILED;
      } else if (cleanup?.status === CLEANUP_STATUS.DELETED) {
        job.status = JOB_STATUS.FAILED;
        job.document = null;
        job.cleanup = structuredClone(cleanup);
      } else {
        job.status = JOB_STATUS.NEEDS_ATTENTION;
        job.cleanup = structuredClone(cleanup ?? { status: CLEANUP_STATUS.NOT_ATTEMPTED });
      }

      this.#releaseLease(job);
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  async recoverExpired() {
    return this.#mutate(async (data) => {
      const timestamp = this.#now();
      const requeued = [];
      const reconciling = [];
      const expired = [];
      const needsAttention = [];
      for (const job of data.jobs) {
        if (job.status === JOB_STATUS.RUNNING && job.leaseExpiresAt <= timestamp) {
          if (job.createInFlight) {
            job.status = JOB_STATUS.RECONCILING;
            this.#releaseLease(job);
            job.createInFlight = false;
            job.ambiguousSince = timestamp;
            job.updatedAt = timestamp;
            reconciling.push(job.attemptId);
            continue;
          }
          job.status = JOB_STATUS.QUEUED;
          job.workerId = null;
          job.leaseExpiresAt = null;
          job.retryCount += 1;
          job.updatedAt = timestamp;
          requeued.push(job.attemptId);
          continue;
        }

        const stale = timestamp - job.updatedAt >= this.#jobTtlMs;
        if (job.status === JOB_STATUS.QUEUED && stale) {
          if (job.document) {
            job.status = JOB_STATUS.NEEDS_ATTENTION;
            job.error = 'Queued job expired after a document was created';
            needsAttention.push(job.attemptId);
          } else {
            job.status = JOB_STATUS.EXPIRED;
            expired.push(job.attemptId);
          }
          job.updatedAt = timestamp;
        } else if (
          (job.status === JOB_STATUS.RECONCILING
            || job.status === JOB_STATUS.CANCEL_PENDING_RECONCILIATION)
          && stale
        ) {
          job.status = JOB_STATUS.NEEDS_ATTENTION;
          job.error = 'Document creation could not be reconciled before expiry';
          job.updatedAt = timestamp;
          needsAttention.push(job.attemptId);
        }
      }
      const changed = requeued.length + reconciling.length + expired.length + needsAttention.length > 0;
      return { result: { requeued, reconciling, expired, needsAttention }, changed };
    });
  }

  #mutate(operation) {
    const run = this.#tail.then(async () => {
      const data = await this.#read();
      const { result, changed } = await operation(data);
      if (changed) await this.#write(data);
      return result;
    });
    this.#tail = run.catch(() => {});
    return run;
  }

  #findJob(data, attemptId) {
    const job = data.jobs.find((candidate) => candidate.attemptId === attemptId);
    if (!job) throw new Error(`Unknown attemptId: ${attemptId}`);
    return job;
  }

  #assertActiveWorker(job, workerId) {
    if (job.status !== JOB_STATUS.RUNNING || job.workerId !== workerId) {
      throw new Error('Only the active worker can update a running job');
    }
  }

  #assertCreateInFlight(job) {
    if (!job.createInFlight) {
      throw new Error('beginCreate must be persisted before recording a document outcome');
    }
  }

  #releaseLease(job) {
    job.workerId = null;
    job.leaseExpiresAt = null;
  }

  async #read() {
    try {
      const data = JSON.parse(await readFile(this.#filePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error('Unsupported job store format');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY_STORE);
      throw error;
    }
  }

  async #write(data) {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.#filePath);
  }
}
