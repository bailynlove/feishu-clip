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

// 双 job 模型（#60/#65）：一次剪藏尝试（attemptId）下可有一条 clip job 与一条 pdf job，
// 查找/幂等键为 (attemptId, kind)；存量 job 读取时缺省 clip
export const JOB_KIND = Object.freeze({
  CLIP: 'clip',
  PDF: 'pdf',
});

export const FAILURE_STAGE = Object.freeze({
  CREATE_DOCUMENT: 'create_document',
  BODY: 'body',
  IMAGES: 'images',
  // pdf job 的唯一失败阶段：下载与上传不加区分（上传歧义一律按失败处理，#60）
  PDF: 'pdf',
});

export const CLEANUP_STATUS = Object.freeze({
  DELETED: 'deleted',
  FAILED: 'failed',
  NOT_ATTEMPTED: 'not_attempted',
  SKIPPED: 'skipped',
});

// 图片写入模式（#53）：preview 预览优先 / download 下载优先 / off 不保存
export const IMAGE_MODES = Object.freeze(['preview', 'download', 'off']);

const JOB_STATUSES = new Set(Object.values(JOB_STATUS));
const JOB_KINDS = new Set(Object.values(JOB_KIND));
const FAILURE_STAGES = new Set(Object.values(FAILURE_STAGE));
const CLEANUP_STATUSES = new Set(Object.values(CLEANUP_STATUS));

function jobKind(job) {
  return JOB_KINDS.has(job?.kind) ? job.kind : JOB_KIND.CLIP;
}

// pdfSource 只接受 url 型（bytes 型凭据通道归 #61）；name/sizeBytes 仅作展示与兜底命名
function normalizePdfSource(pdfSource) {
  if (pdfSource?.type !== 'url') throw new TypeError('pdfSource.type must be url');
  let url;
  try { url = new URL(pdfSource.url); } catch { throw new TypeError('pdfSource.url is not a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('pdfSource.url must be a credential-free http(s) URL');
  }
  const normalized = { type: 'url', url: url.href };
  if (typeof pdfSource.name === 'string' && pdfSource.name) normalized.name = pdfSource.name.slice(0, 250);
  if (Number.isInteger(pdfSource.sizeBytes) && pdfSource.sizeBytes > 0) normalized.sizeBytes = pdfSource.sizeBytes;
  return normalized;
}

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

  async submit({ attemptId, sourceUrl, snapshot = null, destination = null, includeImages = true, imageMode, clientTiming = null, kind = JOB_KIND.CLIP, pdfSource = null, title = null, folderToken = null }) {
    if (!attemptId || !sourceUrl) throw new TypeError('attemptId and sourceUrl are required');
    if (!JOB_KINDS.has(kind)) throw new TypeError(`Unknown job kind: ${kind}`);
    // pdf job（#65）：url 型 pdfSource 必填；title 是扩展侧标题模板渲染结果，用于云盘文件命名；
    // folderToken（#66）是目标云盘目录，null 即根目录
    const normalizedPdfSource = kind === JOB_KIND.PDF ? normalizePdfSource(pdfSource) : null;
    const normalizedFolderToken = typeof folderToken === 'string' && folderToken ? folderToken : null;

    return this.#mutate(async (data) => {
      const existing = data.jobs.find((job) => job.attemptId === attemptId && jobKind(job) === kind);
      if (existing) {
        if (existing.sourceUrl !== sourceUrl) {
          throw new Error(`attemptId ${attemptId} is already bound to another source URL`);
        }
        if (kind === JOB_KIND.PDF && existing.pdfSource.url !== normalizedPdfSource.url) {
          throw new Error(`attemptId ${attemptId} is already bound to another pdf source`);
        }
        // pdf 失败重试（#65 弹窗「重试 PDF」）：终态 failed 的 pdf job 被同键重新提交时
        // 复位重排队，幂等复用同一 job 记录；clip 侧维持原语义（终态重发不复活）。
        // 重试可能换了目录（用户在弹窗重选），folderToken 以本次提交为准
        if (kind === JOB_KIND.PDF && existing.status === JOB_STATUS.FAILED) {
          existing.status = JOB_STATUS.QUEUED;
          existing.error = null;
          existing.workerId = null;
          existing.leaseExpiresAt = null;
          existing.folderToken = normalizedFolderToken;
          existing.retryCount += 1;
          existing.updatedAt = this.#now();
          return { result: { created: false, retried: true, job: structuredClone(existing) }, changed: true };
        }
        return { result: { created: false, job: structuredClone(existing) }, changed: false };
      }

      const timestamp = this.#now();
      if (kind === JOB_KIND.PDF) {
        // pdf job 用最小状态集 queued/running/succeeded/failed/cancelled/expired（#60），
        // 无 reconciling/needs_attention；字段形状与 clip 对齐（读取方不逐个判空）
        const job = {
          jobId: this.#createJobId(),
          attemptId,
          kind,
          sourceUrl,
          title: typeof title === 'string' && title ? title : null,
          pdfSource: normalizedPdfSource,
          folderToken: normalizedFolderToken,
          snapshot: null,
          destination: null,
          status: JOB_STATUS.QUEUED,
          step: null,
          document: null,
          warnings: [],
          error: null,
          retryCount: 0,
          workerId: null,
          leaseExpiresAt: null,
          createInFlight: false,
          timeline: [],
          totalMs: null,
          clientTiming: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        data.jobs.push(job);
        return { result: { created: true, job: structuredClone(job) }, changed: true };
      }
      const job = {
        jobId: this.#createJobId(),
        attemptId,
        kind,
        sourceUrl,
        snapshot,
        destination,
        includeImages,
        // 图片写入模式（#53）：preview/download/off；缺省由 includeImages 布尔推导
        imageMode: imageMode ?? (includeImages === false ? 'off' : 'preview'),
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
        timeline: [],
        totalMs: null,
        clientTiming: clientTiming ? structuredClone(clientTiming) : null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.jobs.push(job);
      return { result: { created: true, job: structuredClone(job) }, changed: true };
    });
  }

  // get(attemptId) 语义（#60）：不传 kind 返回该次尝试的全部 job（数组，可为空）；
  // 传 kind 返回单个 job 或 null。弹窗恢复拿整次尝试，worker 只认自己的 kind
  async get(attemptId, kind = null) {
    const data = await this.#read();
    if (kind === null) {
      return data.jobs.filter((candidate) => candidate.attemptId === attemptId).map((job) => structuredClone(job));
    }
    const job = data.jobs.find((candidate) => candidate.attemptId === attemptId && jobKind(candidate) === kind);
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

  async claim(attemptId, workerId, kind = JOB_KIND.CLIP) {
    if (!workerId) throw new TypeError('workerId is required');
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId, kind);
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

  async cancel(attemptId, kind = JOB_KIND.CLIP) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId, kind);
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

  async complete(attemptId, workerId, { warnings = [], timeline = null, totalMs = null, document = null } = {}, kind = JOB_KIND.CLIP) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId, kind);
      this.#assertActiveWorker(job, workerId);
      if (kind === JOB_KIND.PDF) {
        // pdf job 的 document 是上传产物 { fileToken, url }；上传歧义不走到这里（歧义按失败）
        if (!document?.url) throw new TypeError('pdf job completion requires the uploaded file (url)');
        job.document = structuredClone(document);
        job.status = JOB_STATUS.SUCCEEDED;
      } else {
        if (!job.document) throw new Error('Cannot complete a clip attempt without a document');
        job.status = warnings.length > 0 ? JOB_STATUS.SUCCEEDED_WITH_WARNINGS : JOB_STATUS.SUCCEEDED;
        job.step = JOB_STEP.DONE;
        job.warnings = [...warnings];
      }
      // 耗时埋点只在终态一次性落盘，避免执行期每追加一条就整本重写 jobs.json（内含大 snapshot）
      if (timeline) job.timeline = structuredClone(timeline);
      if (totalMs !== null) job.totalMs = totalMs;
      this.#releaseLease(job);
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  async fail(attemptId, workerId, { stage, error, cleanup = null, timeline = null, totalMs = null }, kind = JOB_KIND.CLIP) {
    if (!stage || !error) throw new TypeError('stage and error are required');
    if (!FAILURE_STAGES.has(stage)) throw new TypeError(`Unknown failure stage: ${stage}`);
    if (cleanup && !CLEANUP_STATUSES.has(cleanup.status)) {
      throw new TypeError(`Unknown cleanup status: ${cleanup.status}`);
    }
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId, kind);
      this.#assertActiveWorker(job, workerId);
      job.error = error;
      job.step = JOB_STEP.DONE;

      if (kind === JOB_KIND.PDF) {
        // pdf 最小状态集（#60）：上传歧义一律按失败处理——同名复传合法并存、孤儿文件无害，
        // 不做 reconciling/needs_attention/孤儿清理
        job.status = JOB_STATUS.FAILED;
      } else if (stage === FAILURE_STAGE.IMAGES && job.document) {
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
      if (timeline) job.timeline = structuredClone(timeline);
      if (totalMs !== null) job.totalMs = totalMs;
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

  #findJob(data, attemptId, kind = JOB_KIND.CLIP) {
    const job = data.jobs.find((candidate) => candidate.attemptId === attemptId && jobKind(candidate) === kind);
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
      // 老 job 文件没有耗时字段，读取侧补缺省值，避免消费方逐个判空
      for (const job of data.jobs) {
        job.timeline ??= [];
        job.totalMs ??= null;
        job.clientTiming ??= null;
        // 双 job 模型（#60/#65）：存量 job 没有 kind，一律按 clip 读取；
        // 存量 pdf job 没有 folderToken（#66 前目录固定根目录），读取时补 null
        job.kind = jobKind(job);
        if (job.kind === JOB_KIND.PDF) job.folderToken ??= null;
      }
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
