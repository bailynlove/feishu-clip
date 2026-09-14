import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_STORE = Object.freeze({ version: 1, jobs: [] });

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  // 凭据回退（#68）：url 型下载撞 401/403 或 bytes 型提交后，等扩展分块回传字节
  AWAITING_BYTES: 'awaiting_bytes',
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

// 分块通道切块口径（#61/#68）：每块 4 MiB 原字节 base64 走 readJson（52 MiB 上限兼容）；
// bytes 声明的 totalChunks 必须与此口径一致。
// 与 src/extension/background.js 的 PDF_CHUNK_BYTES 保持一致（SW 与 bridge 分属两个运行时，
// 无法共享模块，修改须两边同步）
export const PDF_CHUNK_BYTES = 4 * 1024 * 1024;

const JOB_STATUSES = new Set(Object.values(JOB_STATUS));
const JOB_KINDS = new Set(Object.values(JOB_KIND));
const FAILURE_STAGES = new Set(Object.values(FAILURE_STAGE));
const CLEANUP_STATUSES = new Set(Object.values(CLEANUP_STATUS));

// 按 kind 的策略表（review：submit/complete/fail 与 executor 分发处的 kind === PDF 三元收拢于此）：
// 每种 kind 的初始状态、complete/fail 的终态补丁（含各自的前置校验），以及 executor 的
// 消费者入口名。只查表，不引入类层次或插件机制；新增 kind 在这里补一行
export const JOB_KIND_STRATEGY = Object.freeze({
  [JOB_KIND.CLIP]: Object.freeze({
    consumer: 'clip',
    initialStatus: () => JOB_STATUS.QUEUED,
    // clip 完成要求已建档；有警告落 succeeded_with_warnings
    completePatch(job, { warnings }) {
      if (!job.document) throw new Error('Cannot complete a clip attempt without a document');
      return {
        status: warnings.length > 0 ? JOB_STATUS.SUCCEEDED_WITH_WARNINGS : JOB_STATUS.SUCCEEDED,
        step: JOB_STEP.DONE,
        warnings: [...warnings],
      };
    },
    failPatch(job, { stage, error, cleanup }) {
      if (stage === FAILURE_STAGE.IMAGES && job.document) {
        return { status: JOB_STATUS.SUCCEEDED_WITH_WARNINGS, warnings: [error] };
      }
      if (!job.document) return { status: JOB_STATUS.FAILED };
      if (cleanup?.status === CLEANUP_STATUS.DELETED) {
        return { status: JOB_STATUS.FAILED, document: null, cleanup: structuredClone(cleanup) };
      }
      return { status: JOB_STATUS.NEEDS_ATTENTION, cleanup: structuredClone(cleanup ?? { status: CLEANUP_STATUS.NOT_ATTEMPTED }) };
    },
  }),
  [JOB_KIND.PDF]: Object.freeze({
    consumer: 'pdf',
    // bytes 型提交（#68）直接落 awaiting_bytes 等扩展分块回传；url 型落 queued 由 executor 下载
    initialStatus: (pdfSource) => (pdfSource?.type === 'bytes' ? JOB_STATUS.AWAITING_BYTES : JOB_STATUS.QUEUED),
    // pdf job 的 document 是上传产物 { fileToken, url }；上传歧义不走到这里（歧义按失败）。
    // 引用回填（#88）插入失败等部分成功以 warnings 落库，终态保持 succeeded——
    // 弹窗聚合（describeAttemptView）只认 pdf.status === 'succeeded'
    completePatch(job, { document, warnings }) {
      if (!document?.url) throw new TypeError('pdf job completion requires the uploaded file (url)');
      return { document: structuredClone(document), status: JOB_STATUS.SUCCEEDED, warnings: [...warnings] };
    },
    // pdf 最小状态集（#60）：上传歧义一律按失败处理——同名复传合法并存、孤儿文件无害，
    // 不做 reconciling/needs_attention/孤儿清理
    failPatch: () => ({ status: JOB_STATUS.FAILED }),
  }),
});

function kindStrategy(kind) {
  return JOB_KIND_STRATEGY[JOB_KINDS.has(kind) ? kind : JOB_KIND.CLIP];
}

function jobKind(job) {
  return JOB_KINDS.has(job?.kind) ? job.kind : JOB_KIND.CLIP;
}

// pdfSource 两型（#60/#68）：url 型由 bridge 直接下载（撞 401/403 转 awaiting_bytes 回退）；
// bytes 型由扩展持凭据抓取后分块回传，提交时声明文件名/总大小/总块数/SHA-256。
// url 在 bytes 型里同样必填：既是扩展回传的抓取地址，也是幂等绑定键。
// 这是唯一一份校验实现（review：不再 server/store 各写一遍）：store 直接用，TypeError 上
// 携带 code；server 层把 TypeError 按 code 翻译成 400 错误码。maxBytes 仅 server 传入
// （bytes 声明的大小上限与 url 型下载同一档），store 层不重复设限
export function normalizePdfSource(pdfSource, { maxBytes = null } = {}) {
  const bad = (code, message) => Object.assign(new TypeError(message), { code });
  if (pdfSource?.type !== 'url' && pdfSource?.type !== 'bytes') throw bad('PDF_SOURCE_REQUIRED', 'pdfSource.type must be url or bytes');
  let url;
  try { url = new URL(pdfSource.url); } catch { throw bad('PDF_SOURCE_URL_REJECTED', 'pdfSource.url is not a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw bad('PDF_SOURCE_URL_REJECTED', 'pdfSource.url must be a credential-free http(s) URL');
  }
  const normalized = { type: pdfSource.type, url: url.href };
  if (pdfSource.name !== undefined && pdfSource.name !== null) {
    if (typeof pdfSource.name !== 'string' || pdfSource.name.length > 250) {
      throw bad('PDF_SOURCE_INVALID', 'pdfSource.name must be a string of at most 250 chars');
    }
    if (pdfSource.name) normalized.name = pdfSource.name;
  }
  if (pdfSource.sizeBytes !== undefined && pdfSource.sizeBytes !== null) {
    if (!Number.isInteger(pdfSource.sizeBytes) || pdfSource.sizeBytes <= 0) {
      throw bad('PDF_SOURCE_INVALID', 'pdfSource.sizeBytes must be a positive integer');
    }
    normalized.sizeBytes = pdfSource.sizeBytes;
  }
  if (pdfSource.type === 'bytes') {
    // bytes 声明是整验依据：文件名/总大小必填，总块数必须与 4 MiB 切块口径一致，SHA-256 小写 hex
    if (!normalized.name) throw bad('PDF_SOURCE_INVALID', 'pdfSource.name is required for bytes');
    if (normalized.sizeBytes === undefined) throw bad('PDF_SOURCE_INVALID', 'pdfSource.sizeBytes must be a positive integer');
    if (maxBytes !== null && normalized.sizeBytes > maxBytes) throw bad('PDF_SOURCE_TOO_LARGE', 'pdfSource.sizeBytes exceeds the limit');
    const totalChunks = Math.ceil(pdfSource.sizeBytes / PDF_CHUNK_BYTES);
    if (pdfSource.totalChunks !== totalChunks) throw bad('PDF_SOURCE_INVALID', 'pdfSource.totalChunks does not match sizeBytes');
    if (!/^[0-9a-f]{64}$/.test(pdfSource.sha256 || '')) throw bad('PDF_SOURCE_INVALID', 'pdfSource.sha256 must be 64 lowercase hex chars');
    normalized.totalChunks = totalChunks;
    normalized.sha256 = pdfSource.sha256;
  }
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
  // awaiting_bytes 独立短 TTL：回传断在扩展侧（CORS/网络）时 job 不该挂到 job TTL（24h）才死
  #awaitingBytesTtlMs;
  #tail = Promise.resolve();

  constructor({
    filePath,
    now = () => Date.now(),
    createJobId = () => randomUUID(),
    leaseMs = 60_000,
    jobTtlMs = 24 * 60 * 60 * 1_000,
    awaitingBytesTtlMs = null,
  }) {
    if (!filePath) throw new TypeError('filePath is required');
    this.#filePath = filePath;
    this.#now = now;
    this.#createJobId = createJobId;
    this.#leaseMs = leaseMs;
    this.#jobTtlMs = jobTtlMs;
    this.#awaitingBytesTtlMs = awaitingBytesTtlMs;
  }

  async submit({ attemptId, sourceUrl, snapshot = null, destination = null, includeImages = true, imageMode, clientTiming = null, kind = JOB_KIND.CLIP, pdfSource = null, title = null, folderToken = null, digest = null }) {
    if (!attemptId || !sourceUrl) throw new TypeError('attemptId and sourceUrl are required');
    if (!JOB_KINDS.has(kind)) throw new TypeError(`Unknown job kind: ${kind}`);
    // pdf job（#65）：url 型 pdfSource 必填；title 是扩展侧标题模板渲染结果，用于云盘文件命名；
    // folderToken（#66）是目标云盘目录，null 即根目录。
    // clip job（#79）：pdfSource 选填（digest 阶段 {{@file}} 附件用），给了就走同一份校验
    const normalizedPdfSource = pdfSource ? normalizePdfSource(pdfSource) : null;
    if (kind === JOB_KIND.PDF && !normalizedPdfSource) throw Object.assign(new TypeError('pdfSource.type must be url or bytes'), { code: 'PDF_SOURCE_REQUIRED' });
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
        // 重试可能换了目录（用户在弹窗重选），folderToken 以本次提交为准。
        // bytes 型重试（#68）：以新声明为准并回落 awaiting_bytes，等扩展重新喂字节
        if (kind === JOB_KIND.PDF && existing.status === JOB_STATUS.FAILED) {
          existing.status = kindStrategy(kind).initialStatus(normalizedPdfSource);
          existing.pdfSource = normalizedPdfSource;
          existing.error = null;
          existing.workerId = null;
          existing.leaseExpiresAt = null;
          existing.folderToken = normalizedFolderToken;
          existing.retryCount += 1;
          existing.updatedAt = this.#now();
          return { result: { created: false, retried: true, job: structuredClone(existing) }, changed: true };
        }
        // 凭据回退升级（#68）：url 型撞 401/403 转 awaiting_bytes 后，扩展补交 bytes 声明
        // （同 url 绑定，上面的 url 校验已拦下异源）。声明一旦落库即粘滞：同 sha 幂等，
        // 异 sha 拒绝——源站内容变了应让任务失败后重来，不在中途换声明使已收块失效
        if (kind === JOB_KIND.PDF && existing.status === JOB_STATUS.AWAITING_BYTES
          && existing.pdfSource.type === 'url' && normalizedPdfSource.type === 'bytes') {
          existing.pdfSource = normalizedPdfSource;
          existing.updatedAt = this.#now();
          return { result: { created: false, upgraded: true, job: structuredClone(existing) }, changed: true };
        }
        if (kind === JOB_KIND.PDF && existing.status === JOB_STATUS.AWAITING_BYTES
          && existing.pdfSource.type === 'bytes' && normalizedPdfSource.type === 'bytes'
          && existing.pdfSource.sha256 !== normalizedPdfSource.sha256) {
          throw new Error(`attemptId ${attemptId} is already bound to another pdf source`);
        }
        return { result: { created: false, job: structuredClone(existing) }, changed: false };
      }

      const timestamp = this.#now();
      if (kind === JOB_KIND.PDF) {
        // pdf job 用最小状态集（#60）：queued/awaiting_bytes/running/succeeded/failed/cancelled/expired，
        // 无 reconciling/needs_attention；字段形状与 clip 对齐（读取方不逐个判空）。
        // 初始状态按 kind 策略表：bytes 型提交（#68）直接落 awaiting_bytes 等分块回传；
        // url 型落 queued 由 executor 下载
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
          status: kindStrategy(kind).initialStatus(normalizedPdfSource),
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
        // AI 摘要（#75）：digest 是提交时的请求 { enabled, instruction, provider? }（provider #78）；digestText 是生成
        // 结果缓存——落库后重跑（reconcile 重排/任何原因重入 #execute）都不再调 AI
        digest: digest ? structuredClone(digest) : null,
        digestText: null,
        // 摘要子文档（#98）：subdoc 模式下建档后创建的 Digest 子文档 { documentId, nodeToken, url }；
        // 落库后重跑直接复用，不再重复建子文档
        digestDoc: null,
        // {{@file}} 附件（#79）：本次剪藏检出的 PDF，digest 阶段据此下载字节随摘要请求发出
        pdfSource: normalizedPdfSource ? structuredClone(normalizedPdfSource) : null,
        // PDF 云盘引用回填的幂等标记（#88）：pdf job 上传成功后把 PDF 插到本文档开头，
        // 置位后 pdf job 重试/重跑不再重复插入
        pdfRefInserted: false,
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

  // AI 摘要结果缓存（#75）：worker 守卫仿 recordDocument，但不要求 createInFlight——
  // inline 模式下 digest 阶段在建档（beginCreate）之前运行
  async recordDigest(attemptId, workerId, digestText) {
    if (typeof digestText !== 'string') throw new TypeError('digestText is required');
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      this.#assertActiveWorker(job, workerId);
      job.digestText = digestText;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  // 摘要子文档落库（#98）：subdoc 模式建档后创建 Digest 子文档，落库供重跑复用；
  // worker 守卫仿 recordDigest，不要求 createInFlight（subdoc 的 digest 阶段在建档之后运行）
  async recordDigestDoc(attemptId, workerId, digestDoc) {
    if (
      !digestDoc || typeof digestDoc !== 'object' ||
      typeof digestDoc.documentId !== 'string' || !digestDoc.documentId ||
      typeof digestDoc.nodeToken !== 'string' || !digestDoc.nodeToken ||
      typeof digestDoc.url !== 'string' || !digestDoc.url
    ) {
      throw new TypeError('digestDoc 需要 documentId/nodeToken/url 三个非空字符串字段');
    }
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId);
      this.#assertActiveWorker(job, workerId);
      job.digestDoc = structuredClone(digestDoc);
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  // PDF 云盘引用回填的幂等标记（#88）：mark-before-insert——pdf job 先置位再插入，
  // 租约过期被 recoverExpired 重排后另一执行体读不到 claimed 就跳过，不双插；
  // 插入失败由调用方以 inserted=false 清除标记，重试可补插。返回 { job, claimed }：
  // claimed=true 仅当本调用完成 false→true 跃迁（抢到了插入权）。
  // clip job 此时通常已是终态（凭据回退场景 pdf 晚于 clip 完成），故不做 worker 守卫
  async markPdfRefInserted(attemptId, inserted = true) {
    if (typeof inserted !== 'boolean') throw new TypeError('inserted must be a boolean');
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId, JOB_KIND.CLIP);
      const claimed = inserted === true && job.pdfRefInserted !== true;
      if (job.pdfRefInserted === inserted) return { result: { job: structuredClone(job), claimed }, changed: false };
      job.pdfRefInserted = inserted;
      job.updatedAt = this.#now();
      return { result: { job: structuredClone(job), claimed }, changed: true };
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
      if (job.status !== JOB_STATUS.QUEUED && job.status !== JOB_STATUS.RUNNING && job.status !== JOB_STATUS.AWAITING_BYTES) {
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
      // 终态判定按 kind 策略表（completePatch 内含各自的前置校验，先算补丁再落，避免半改状态）
      Object.assign(job, kindStrategy(kind).completePatch(job, { warnings, document }));
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
      // 失败后的状态归集按 kind 策略表（clip 按阶段/清理结果分流；pdf 恒 failed）
      Object.assign(job, kindStrategy(kind).failPatch(job, { stage, error, cleanup }));

      this.#releaseLease(job);
      if (timeline) job.timeline = structuredClone(timeline);
      if (totalMs !== null) job.totalMs = totalMs;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  // ——— 凭据回退（#68）：awaiting_bytes 的三个流转 ———

  // url 型下载撞 401/403：不 fail，转 awaiting_bytes 等扩展持凭据分块回传
  async awaitBytes(attemptId, workerId) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId, JOB_KIND.PDF);
      this.#assertActiveWorker(job, workerId);
      job.status = JOB_STATUS.AWAITING_BYTES;
      this.#releaseLease(job);
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  // 凭据回退的另一半触发路径（#80）：clip 的 digest 阶段自行下载撞 401/403 时，pdf job 还
  // 排在队列里（提交序 clip 在前、executor 串行消费），等不到它自己撞凭据——由 clip 侧把
  // 排队中的 url 型 pdf job 直接转 awaiting_bytes（与 awaitBytes 同终态），弹窗轮询看到后喂字节。
  // 已 awaiting（含 bytes 型提交）幂等空转；其余状态拒绝，调用方按降级语义处理
  async requestBytes(attemptId) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId, JOB_KIND.PDF);
      if (job.status === JOB_STATUS.AWAITING_BYTES) return { result: structuredClone(job), changed: false };
      if (job.status !== JOB_STATUS.QUEUED || job.pdfSource?.type !== 'url') {
        throw new Error(`Cannot request bytes for pdf job in ${job.status} state`);
      }
      job.status = JOB_STATUS.AWAITING_BYTES;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  // 分块全部到齐且 SHA-256 整验通过 → 重排队，executor 拾取后走 staging 字节上传
  async markBytesReady(attemptId) {
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId, JOB_KIND.PDF);
      if (job.status !== JOB_STATUS.AWAITING_BYTES) throw new Error(`Cannot mark bytes ready in ${job.status} state`);
      job.status = JOB_STATUS.QUEUED;
      job.updatedAt = this.#now();
      return { result: structuredClone(job), changed: true };
    });
  }

  // 整验失败（SHA-256/大小不匹配）→ failed；staging 清理由调用方负责
  async failBytes(attemptId, error) {
    if (!error) throw new TypeError('error is required');
    return this.#mutate(async (data) => {
      const job = this.#findJob(data, attemptId, JOB_KIND.PDF);
      if (job.status !== JOB_STATUS.AWAITING_BYTES) throw new Error(`Cannot fail awaiting-bytes job in ${job.status} state`);
      job.status = JOB_STATUS.FAILED;
      job.error = error;
      job.step = JOB_STEP.DONE;
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
        // awaiting_bytes 独立短 TTL（未配置时回落 job TTL）：字节始终没喂齐 → expired，
        // 写明原因让 popup 呈现失败而非永远「凭据回传中…」；staging 残留由调用方（sweep）清理
        const bytesStale = timestamp - job.updatedAt >= (this.#awaitingBytesTtlMs ?? this.#jobTtlMs);
        if (job.status === JOB_STATUS.AWAITING_BYTES && bytesStale) {
          job.status = JOB_STATUS.EXPIRED;
          // 中文文案是面向 popup 状态条的用户可读展示（相邻存量英文错误是日志向，分工不同）
          job.error = '等待浏览器凭据回传超时，请重开弹窗重试';
          job.updatedAt = timestamp;
          expired.push(job.attemptId);
        } else if (job.status === JOB_STATUS.QUEUED && stale) {
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
        // AI 摘要（#75）：存量 clip job 没有 digest/digestText，读取时补 null；
        // {{@file}} 附件（#79）：存量 clip job 没有 pdfSource，读取时补 null
        if (job.kind === JOB_KIND.CLIP) {
          job.digest ??= null;
          job.digestText ??= null;
          job.pdfSource ??= null;
          // 引用回填（#88）：存量 clip job 没有 pdfRefInserted，读取时补 false
          job.pdfRefInserted ??= false;
          // 摘要子文档（#98）：存量 clip job 没有 digestDoc，读取时补 null
          job.digestDoc ??= null;
        }
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
