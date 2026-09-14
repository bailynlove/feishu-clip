import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FAILURE_STAGE, IMAGE_MODES, JOB_KIND, JOB_KIND_STRATEGY, JOB_STATUS } from './job-store.mjs';
import { downloadPublicImage, downloadPublicPdf, IMAGE_LIMITS, PDF_LIMITS, parseImageDimensions, validateImageBytes } from './image-policy.mjs';
import { applyDigest, AI_FILE_MAX_BYTES, generateDigest as requestDigest, hasFilePlaceholder } from './ai-digest.mjs';

// 尝试标记：写在元信息引用块里（prepareMarkdown），reconcile 靠它在 wiki 里反查认领文档
const ATTEMPT_MARKER_PREFIX = '剪藏尝试：';

function safeTitle(value) {
  return String(value || '网页剪藏').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 180) || '网页剪藏';
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// 云盘 PDF 文件名（#65）：标题模板渲染结果 + .pdf；空标题回退 pdfSource.name、再退 URL 末段。
// 飞书文件名上限 250 字符（#57 事实），截断留足 .pdf 后缀
const FILENAME_UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

function safeFileBase(value) {
  return String(value || '').replace(FILENAME_UNSAFE, '-').replace(/[\r\n\t]+/g, ' ').trim().replace(/\.+$/, '').slice(0, 240);
}

export function pdfFileName({ title, url, fallback = null }) {
  let base = safeFileBase(title);
  if (!base && fallback) base = safeFileBase(String(fallback).replace(/\.pdf$/i, ''));
  if (!base) {
    try {
      base = safeFileBase(decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').replace(/\.pdf$/i, ''));
    } catch { base = ''; }
  }
  return `${base || 'clip'}.pdf`;
}

// pdf 失败的弹窗文案：机器码翻译成可读提示，其余透传原始消息
function pdfErrorMessage(error) {
  if (error?.code === 'PDF_SIZE_REJECTED') return `PDF 超过大小上限（${Math.round(PDF_LIMITS.maxBytes / 1024 / 1024)} MiB），未上传`;
  if (error?.code === 'PDF_TYPE_REJECTED') return '下载到的内容不是 PDF 文件';
  if (error?.code === 'PDF_SSRF_REJECTED') return 'PDF 地址不安全，已拒绝下载';
  return error?.message || 'PDF 上传失败';
}

// AI 摘要失败的中文文案（#75）：机器码翻译成可读提示，其余透传原始消息；
// executor 的 digest 警告与 server 的 /v1/ai/test 失败响应共用这一份
export function aiErrorMessage(error) {
  if (error?.code === 'AI_NOT_CONFIGURED') return '未配置 AI API';
  if (error?.code === 'AI_AUTH_FAILED') return 'AI API 密钥无效或没有权限';
  if (error?.code === 'AI_RATE_LIMITED') return 'AI API 触发限流，请稍后重试';
  if (error?.code === 'AI_TIMEOUT') return 'AI API 请求超时';
  return error?.message || 'AI 摘要生成失败';
}

// 凭据回退判定（#68）：url 型下载撞 401/403 不算失败，转 awaiting_bytes 等扩展分块回传。
// statusCode 由 image-policy 在 HTTP 非 200 错误上携带
function needsCredentialFallback(error) {
  return error?.code === 'PDF_FETCH_FAILED' && (error.statusCode === 401 || error.statusCode === 403);
}

// pdf 下载瞬时网络错误判定：只认裸系统错误码（对端 reset / 超时 / 拒连 / DNS 抖动）。
// 带 PDF_* 业务码的失败（401/403 凭据回退、SIZE/TYPE/SSRF 拒绝）绝不重试，语义不变。
// 背景：arXiv 等对同 IP 并发连接数有限制，clip 图片下载与 pdf 下载同主机并发会被 reset
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);

function isTransientNetworkError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('PDF_')) return false;
  if (TRANSIENT_NETWORK_CODES.has(error?.code)) return true;
  return /socket hang up/i.test(error?.message || '');
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// digest 等 staging 字节的边界（#80）：轮询 1s、总预算 120s——喂字节是「弹窗观察 → SW 两遍
// 流式读 → 分块 POST」的交互链路，120s 覆盖常规体积；预算按轮询次数计（sleep 可注入，
// 测试不等真实时长）。放弃条件：预算耗尽 / pdf job 终态 / bytes 声明超 32 MB 附件上限
export const DIGEST_PDF_WAIT_MS = 120_000;
const DIGEST_PDF_POLL_MS = 1_000;
// 租约心跳间隔（#89）：lease 60s，15s 一次续约留有 3 倍余量；须显著小于 job-store 的 leaseMs
const HEARTBEAT_MS = 15_000;
// 摘要等 pdf 通道共享字节的预算（#94）：常规下载几秒；pdf 需重试/大文件时等满即回退自己下载
const PDF_SHARE_WAIT_MS = 30_000;
// 共享拒绝码（#94）：pdf 转凭据回退（awaiting_bytes）时以此拒绝共享，
// 摘要侧映射成 401 形状直接进 #80 staging 等待，不重复撞一次 401
const PDF_SHARE_CREDENTIALS = 'PDF_SHARE_CREDENTIALS';
// 等待期间的放弃态：pdf 最小状态集里的四个终态（succeeded 时 staging 已随收尾 discard，同样取不到）
const PDF_GIVE_UP_STATUSES = new Set([JOB_STATUS.SUCCEEDED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED, JOB_STATUS.EXPIRED]);

// 引用回填（#88）：clip job 尚无 document 时区分「仍在建」与「失败终态」——
// 仍在建（这些非终态）记警告使可见；失败终态属「不产生引用」静默跳过
const CLIP_DOC_PENDING_STATUSES = new Set([
  JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, JOB_STATUS.RECONCILING, JOB_STATUS.CANCEL_PENDING_RECONCILIATION,
]);

// 瞬时错误自动重试：最多 2 次重试（共 3 次尝试），退避约 1s / 3s。
// fn 收到从 1 起的 attempt 序号——下载路径据此轮转 A 记录换 CDN 边缘节点（#92）。
// sleep 可注入（测试不等真实退避）；onRetry 用于 timeline 埋点
async function withTransientRetry(fn, { sleep = defaultSleep, backoffMs = [1000, 3000], onRetry = () => {} } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= 1 + backoffMs.length || !isTransientNetworkError(error)) throw error;
      onRetry(error, attempt);
      await sleep(backoffMs[attempt - 1]);
    }
  }
}

function escapeMarkdown(value) {
  return String(value || '').replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

// 图片写入模式三态（#53）：off 不处理图片（锚点落成可读文本）；preview/download 都保留锚点，
// 差别在 bridge 图片阶段——download 跳过预览块 pass，公开图片也直接进下载管线
export function prepareMarkdown(snapshot, attemptId, { imageMode = 'off' } = {}) {
  const images = Array.isArray(snapshot.images) ? snapshot.images.slice(0, IMAGE_LIMITS.maxImages).map((image) => ({ ...image })) : [];
  let body = String(snapshot.markdown || '').slice(0, 1_500_000);
  if (imageMode === 'off') {
    // 不处理图片时锚点直接落成可读文本（含原图链接）；处理时保留锚点供 bridge 图片阶段定位
    for (const [index, image] of images.entries()) {
      const label = escapeMarkdown(image.label || `图片 ${index + 1}`);
      const source = safeHttpUrl(image.source);
      body = body.replaceAll(`[[FEISHU_CLIP_IMAGE:${index}]]`, source ? `图片：${label}（[原图链接](${source})）` : `图片：${label}`);
    }
    body = body.replace(/\[\[FEISHU_CLIP_IMAGE:\d+\]\]/g, '图片：未能处理');
  } else {
    // 处理图片时保留锚点：bridge 图片阶段按「预览块 → 下载上传 → 纯链接」三级降级处理。
    // URL 不安全又无字节的图哪级都建不了，直接降级为文本，不留锚点
    for (const [index, image] of images.entries()) {
      if (!image.bytesBase64 && !safeHttpUrl(image.source)) {
        const label = escapeMarkdown(image.label || `图片 ${index + 1}`);
        body = body.replaceAll(`[[FEISHU_CLIP_IMAGE:${index}]]`, `图片：${label}`);
      }
    }
  }
  const source = safeHttpUrl(snapshot.sourceUrl);
  const metadata = [
    source ? `> 来源：[${escapeMarkdown(source)}](${source})` : '> 来源：不可用',
    `> 剪藏时间：${new Date(snapshot.capturedAt || Date.now()).toISOString()}`,
    `> ${ATTEMPT_MARKER_PREFIX}${attemptId}`,
    '',
  ].join('\n');
  return { markdown: `${metadata}${body}`.trim(), images };
}

function parseDocument(envelope) {
  const document = envelope.data?.document || envelope.data;
  const documentId = document.document_id || document.documentId;
  const url = document.url;
  if (!documentId || !url) throw new Error('LARK_CREATE_MISSING_DOCUMENT');
  return { documentId, url };
}

function parseCreatedNode(envelope) {
  const node = envelope.data?.node || envelope.data;
  const documentId = node.obj_token || node.document_id;
  const url = node.url || node.node_url;
  if (!documentId || !url) throw new Error('LARK_CREATE_MISSING_DOCUMENT');
  return { documentId, url };
}

async function imageBytes(image) {
  if (image.bytesBase64) {
    const buffer = Buffer.from(image.bytesBase64, 'base64');
    return { buffer, source: image.source || null, metadata: validateImageBytes(buffer, image.mimeType) };
  }
  const source = safeHttpUrl(image.source);
  if (!source) throw Object.assign(new Error('图片地址不安全或浏览器未提供字节'), { code: 'IMAGE_SOURCE_UNAVAILABLE' });
  return downloadPublicImage(source);
}

// snapshot 里 extractor 记录的 naturalWidth/Height：只有 1-100000 的整数才可信，
// 脏值（0/小数/超大）一律视为没有，回退到字节解析
function snapshotDimensions(image) {
  const { width, height } = image;
  const valid = (value) => Number.isInteger(value) && value >= 1 && value <= 100_000;
  return valid(width) && valid(height) ? { width, height } : null;
}

// 文本提取泛化：任何带 elements 数组的属性都读（text/bullet/ordered/code/heading…），
// 不假设锚点一定是 block_type 2 的段落
function blockText(block) {
  for (const value of Object.values(block)) {
    if (value && typeof value === 'object' && Array.isArray(value.elements)) {
      return value.elements.map((element) => element.text_run?.content || '').join('');
    }
  }
  return '';
}

// 从全量块列表一次性定位所有锚点：块 id、父块 id、父块内下标都在块数据里，
// 不再需要每个锚点做 keyword 探测（旧流程 14 图约 22s）。
// 只接受独立成块的锚点（块文本 trim 后严格等于锚点）：混在列表项/代码块文本中间的
// 锚点若原生删除会把有内容的块误删，那种返回 null 由调用方走降级回退
function locateAnchors(items, markers) {
  const byId = new Map(items.map((item) => [item.block_id, item]));
  const anchors = [];
  for (const marker of markers) {
    const block = items.find((item) => blockText(item).trim() === marker);
    const parent = block ? byId.get(block.parent_id) : null;
    const at = parent?.children?.indexOf(block.block_id) ?? -1;
    anchors.push(block && parent && at >= 0 ? { blockId: block.block_id, parentId: parent.block_id, index: at } : null);
  }
  return anchors;
}

// 服务端整体超时：lark-cli 把飞书网关的 "server time out error" 归为 network/timeout。
// 与本地 CLI 超时（LARK_TIMEOUT）不同——服务端可能已实际建出文档，无文档句柄时按建档歧义处理
function isServerTimeout(error) {
  return /server time out/i.test(error?.message || '');
}

export class ClipExecutor {
  constructor({ store, lark, logger = console, downloadPdf = downloadPublicPdf, staging = null, sleep = defaultSleep, generateDigest = requestDigest, getAiConfig = async () => null, digestPdfWaitMs = DIGEST_PDF_WAIT_MS, heartbeatMs = HEARTBEAT_MS, pdfShareWaitMs = PDF_SHARE_WAIT_MS }) {
    this.store = store;
    this.lark = lark;
    this.logger = logger;
    // pdf 下载函数可注入（测试 stub；生产默认走 image-policy 的 SSRF 校验下载）
    this.downloadPdf = downloadPdf;
    // AI 摘要（#75）：generateDigest/getAiConfig 可注入（测试 fake，仿 downloadPdf）；
    // 生产默认接 ai-digest.mjs，配置由 server 传入的 ai.json store 读取。
    // getAiConfig(name)（#78）：name 非空按名取 provider，null 走默认 provider
    this.generateDigest = generateDigest;
    this.getAiConfig = getAiConfig;
    // 重试退避 sleep 可注入（测试不等真实退避；生产为 setTimeout）
    this.sleep = sleep;
    // 租约心跳间隔（#89）可注入（测试用 10ms 级；生产默认 15s）
    this.heartbeatMs = heartbeatMs;
    // 分块暂存（#68）：bytes 型 pdf job 的字节来源；null 时 bytes 路径不可用（仅测试场景）
    this.staging = staging;
    // digest 等 staging 字节的总预算（#80），可注入（测试不等真实时长）
    this.digestPdfWaitMs = digestPdfWaitMs;
    // 摘要附件字节共享（#94）：attemptId → deferred { promise, resolve, reject }。
    // 内存表不落盘；clip 终态清理（#execute finally）
    this.pdfShares = new Map();
    // 摘要进度（#86）：attemptId → { phase: 'thinking' | 'writing', tokens }。流式 delta 逐次
    // 更新（纯内存赋值，无锁）；不落盘——job-store 是整文件重写，禁高频写。GET job 视图时由
    // server 经 digestProgressOf 合并输出；clip 终态清理（#execute finally）
    this.digestProgress = new Map();
    // 摘要等共享字节的预算（#94），可注入（测试用即时超时）
    this.pdfShareWaitMs = pdfShareWaitMs;
    // 双通道（#91）：clip/pdf 各一条消费通道，互不占线
    this.laneRunning = { clip: false, pdf: false };
    this.reconcileRunning = false;
    // 消费者入口按 kind 策略表分发（review：不再写 kind === PDF 三元）；未知 kind 兜底 clip
    this.consumers = {
      clip: (job) => this.#execute(job),
      pdf: (job) => this.#executePdf(job),
    };
  }

  // 双通道（#91）：clip 通道串行（防 wiki 建档竞争），pdf 独立通道与 clip 并行——
  // pdf job 不再排队等 clip 的摘要/建档，同批任务总耗时 ≈ max(两者) 而非 sum。
  // 通道名即 JOB_KIND_STRATEGY 的 consumer 名；未知 kind 兜底进 clip 通道
  kick() {
    this.#kickLane('clip');
    this.#kickLane('pdf');
  }

  #laneOf(job) {
    return (JOB_KIND_STRATEGY[job.kind] ?? JOB_KIND_STRATEGY[JOB_KIND.CLIP]).consumer;
  }

  #kickLane(lane) {
    if (this.laneRunning[lane]) return;
    this.laneRunning[lane] = true;
    queueMicrotask(() => this.#drainLane(lane).finally(async () => {
      this.laneRunning[lane] = false;
      const queued = await this.store.list({ statuses: [JOB_STATUS.QUEUED] });
      if (queued.some((job) => this.#laneOf(job) === lane)) this.#kickLane(lane);
    }));
  }

  async #drainLane(lane) {
    for (;;) {
      const queued = await this.store.list({ statuses: [JOB_STATUS.QUEUED] });
      const job = queued.find((candidate) => this.#laneOf(candidate) === lane);
      if (!job) return;
      await this.consumers[this.#laneOf(job)](job).catch((error) => this.logger.error('worker failed', { lane, attemptId: job.attemptId, error }));
    }
  }

  // 租约心跳（#89）：digest/下载/CLI 等长阶段动辄超过 60s 租约，执行期间按 heartbeatMs
  // 周期续约，防 recoverExpired 把活跃任务误重排（摘要重复执行、原执行体收尾被拒
  // 「Only the active worker」）。心跳失败 = 租约真被收走：置 lost 并停表，阶段边界由
  // #assertLease 抛 LEASE_LOST 提前中止——之后的写库本就会因 worker 校验被拒，提前抛
  // 只是不浪费剩余工作。返回的 lease.stop() 在执行收尾（finally）调用
  #startHeartbeat(attemptId, workerId) {
    const lease = { lost: false, stop: () => clearInterval(timer) };
    const timer = setInterval(async () => {
      try {
        await this.store.heartbeat(attemptId, workerId);
      } catch (error) {
        lease.lost = true;
        lease.stop();
        this.logger.warn?.('租约心跳失败，中止本次执行', { attemptId, error: error?.message || String(error) });
      }
    }, this.heartbeatMs);
    timer.unref?.();
    return lease;
  }

  #assertLease(lease) {
    if (lease?.lost) throw Object.assign(new Error('租约已丢失，执行被重排接管'), { code: 'LEASE_LOST' });
  }

  // 摘要附件字节共享（#94）：url 型 pdf job 与同次 clip 摘要下载的是同一 URL，pdf 通道
  // 下载成功后经此内存表把字节交给摘要——少一次重复下载，也少一倍对 arXiv 这类 RST 高发
  // 主机的暴露面。offer/reject 仅在 clip job 存在时调用（PDF 标签页直存云盘不产生共享）；
  // reject 也建条目——clip 可能尚未开始等，拒绝须留痕；promise 预挂 catch 防无人消费时
  // 变 unhandledRejection
  #pdfShareEntry(attemptId) {
    let entry = this.pdfShares.get(attemptId);
    if (!entry) {
      let settle;
      const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      promise.catch(() => {});
      entry = { promise, ...settle };
      this.pdfShares.set(attemptId, entry);
    }
    return entry;
  }

  // 摘要进度读取（#86）：server 组 job 视图时合并；无进行中摘要（非 digest job / 已终态）返回 null
  digestProgressOf(attemptId) {
    const entry = this.digestProgress.get(attemptId);
    return entry ? { phase: entry.phase, tokens: entry.tokens } : null;
  }

  // 摘要侧等共享：返回 { buffer } / null（自己下载）/ 抛 401 形状错误（凭据回退进 #80）。
  // 无 pdf job、pdf 已终态且没留下字节、pdf 为 bytes 型（走 #80 staging）、等待超时、
  // pdf 下载失败——都回 null 由调用方自己下载（带 #92 重试）
  async #awaitSharedPdf(job) {
    const existing = this.pdfShares.get(job.attemptId);
    if (!existing) {
      const pdfJob = await this.store.get(job.attemptId, JOB_KIND.PDF).catch(() => null);
      if (!pdfJob || PDF_GIVE_UP_STATUSES.has(pdfJob.status) || pdfJob.pdfSource?.type !== 'url') return null;
    }
    const entry = existing ?? this.#pdfShareEntry(job.attemptId);
    const TIMEOUT = Symbol('pdf-share-timeout');
    // 超时用独立 unref 定时器而非注入 sleep：race 落败的 sleep 定时器会 ref 住进程（测试
    // 退出慢/挂起），且注入的脚本化 sleep 是按调用次数驱动状态机的，此处多消费一次会把
    // #80 凭据回退测试的轮询序列整体挤歪。预算仍由 pdfShareWaitMs 注入（测试给 0）。
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), this.pdfShareWaitMs); });
    timer.unref?.();
    const result = await Promise.race([entry.promise, timeout])
      .catch((error) => error);
    clearTimeout(timer);
    if (result === TIMEOUT) return null;
    if (result instanceof Error) {
      if (result.code === PDF_SHARE_CREDENTIALS) {
        throw Object.assign(new Error('PDF_HTTP_401'), { code: 'PDF_FETCH_FAILED', statusCode: 401 });
      }
      return null;
    }
    return result;
  }

  // pdf job 消费者（#65）：url 型按 pdfSource.url 下载（image-policy 的 SSRF/逐跳校验 +
  // 100 MiB 硬上限）；bytes 型（#68 凭据回退）字节已在 staging 整验过，复制进任务目录即可。
  // 落盘后都经 lark-cli drive +upload 原格式上传云盘；job.folderToken（#66）是 picker/
  // 弹窗选定的目标目录，null 即根目录（省略 --folder-token）。
  // 上传歧义一律按失败处理（#60）：不查重不 reconcile——同名复传合法并存、孤儿文件无害（#57 实测）。
  // 唯一例外：url 型下载撞 401/403 不 fail，转 awaiting_bytes 等扩展持凭据分块回传（#68）
  async #executePdf(job) {
    const workerId = randomUUID();
    await this.store.claim(job.attemptId, workerId, JOB_KIND.PDF);
    const scratch = await mkdtemp(path.join(tmpdir(), 'feishu-clip-pdf-'));
    // 长下载/上传期间周期续约（#89），收尾 finally 停表；挂在 mkdtemp 之后，
    // 防建目录抛错时计时器泄漏、持续给未进入 try 的死任务续约
    const lease = this.#startHeartbeat(job.attemptId, workerId);
    const isBytes = job.pdfSource?.type === 'bytes';
    const startedAt = Date.now();
    const timeline = [];
    const timing = () => ({ timeline, totalMs: Date.now() - startedAt });
    try {
      const name = pdfFileName({ title: job.title, url: job.pdfSource.url, fallback: job.pdfSource.name });
      if (isBytes) {
        // staging 文件已按声明整验（size + SHA-256）；复制成正式文件名供 lark-cli 相对路径上传
        const stageAt = Date.now();
        await copyFile(this.staging.filePath(job.attemptId), path.join(scratch, name));
        timeline.push({ kind: 'stage', name: 'pdf_staging', ms: Date.now() - stageAt });
      } else {
        const downloadAt = Date.now();
        // 瞬时网络错误（ECONNRESET 类）自动重试：arXiv 等站点限制同 IP 并发连接，
        // clip 图片与 pdf 同主机并发下载会被对端 reset；业务失败（PDF_*）不重试
        const fetched = await withTransientRetry((attempt) => this.downloadPdf(job.pdfSource.url, { attempt }), {
          sleep: this.sleep,
          onRetry: (error, attempt) => timeline.push({ kind: 'retry', name: 'pdf_download', detail: `${error?.code || error?.message}，第 ${attempt} 次重试` }),
        });
        timeline.push({ kind: 'stage', name: 'pdf_download', ms: Date.now() - downloadAt });
        await writeFile(path.join(scratch, name), fetched.buffer);
        // 字节共享（#94）：同次 clip 的摘要阶段可能在等这份字节，下载成功即共享，
        // 免摘要第二次下载。仅当 clip job 存在且非终态时才建共享条目
        const clip = await this.store.get(job.attemptId, JOB_KIND.CLIP).catch(() => null);
        if (clip && !PDF_GIVE_UP_STATUSES.has(clip.status)) this.#pdfShareEntry(job.attemptId).resolve({ buffer: fetched.buffer });
      }
      const uploadAt = Date.now();
      this.#assertLease(lease);
      const uploaded = await this.lark.uploadDriveFile({
        localFileName: name, // cwd 下落盘的相对文件名（--file 约束）
        displayName: name, // 云盘展示名
        folderToken: job.folderToken ?? null, // #66：picker/弹窗选定的目录；null 走根目录
        cwd: scratch,
      });
      timeline.push({ kind: 'cli', name: 'drive +upload', ms: Date.now() - uploadAt });
      // PDF 云盘引用回填（#88）：上传成功后把该 PDF 以「@」引用插到本次 clip 文档开头的
      // 引用容器。插在 complete 之前，失败警告才能随 result.warnings 落库；插入失败只记
      // 警告——上传已成功，job 不失败。skip 情形也可能带回警告（clip 文档尚未建好）
      const warnings = [];
      const refAt = Date.now();
      try {
        const ref = await this.#insertPdfReference(job, uploaded, name);
        if (ref?.warning) warnings.push(ref.warning);
        if (ref?.inserted) timeline.push({ kind: 'stage', name: 'pdf_ref_insert', ms: Date.now() - refAt });
      } catch (error) {
        timeline.push({ kind: 'stage', name: 'pdf_ref_insert', ms: Date.now() - refAt, detail: String(error?.message || error).slice(0, 300) });
        warnings.push(`PDF 云盘引用插入失败：${error?.message || '未知错误'}`);
      }
      await this.store.complete(job.attemptId, workerId, { document: uploaded, warnings, ...timing() }, JOB_KIND.PDF);
    } catch (error) {
      if (error.code === 'LEASE_LOST') {
        // 租约已被收走：由接管的新执行体负责终态，这里只记日志不写库
        this.logger.warn?.('租约丢失，pdf 执行中止', { attemptId: job.attemptId });
      } else {
        const current = await this.store.get(job.attemptId, JOB_KIND.PDF);
        if (current?.status === JOB_STATUS.RUNNING && current.workerId === workerId) {
          if (!isBytes && needsCredentialFallback(error)) {
            // 401/403（付费墙等）：不 fail，转 awaiting_bytes，弹窗轮询看到后经 SW 喂字节（#68）
            await this.store.awaitBytes(job.attemptId, workerId);
            // 共享以凭据语义拒绝（#94）：摘要侧直接进 #80 staging 等待，不重复撞 401
            const clip = await this.store.get(job.attemptId, JOB_KIND.CLIP).catch(() => null);
            if (clip && !PDF_GIVE_UP_STATUSES.has(clip.status)) {
              this.#pdfShareEntry(job.attemptId).reject(Object.assign(new Error('PDF 需登录凭据'), { code: PDF_SHARE_CREDENTIALS }));
            }
            this.logger.log?.('pdf download requires credentials, awaiting extension bytes', { attemptId: job.attemptId, statusCode: error.statusCode });
          } else {
            await this.store.fail(job.attemptId, workerId, { stage: FAILURE_STAGE.PDF, error: pdfErrorMessage(error), ...timing() }, JOB_KIND.PDF);
            // 共享拒绝（#94）：摘要侧收到后回退自己下载
            this.pdfShares.get(job.attemptId)?.reject(error);
            this.logger.error('pdf job failed', { attemptId: job.attemptId, error });
          }
        } else {
          this.logger.error('pdf job failed', { attemptId: job.attemptId, error });
        }
      }
    } finally {
      lease.stop();
      await rm(scratch, { recursive: true, force: true });
      // staging 随终态删除（#68）：bytes 路径无论成败，收尾后清掉 .part 与位图 sidecar
      if (isBytes) await this.staging?.discard(job.attemptId).catch(() => {});
    }
  }

  // PDF 云盘引用回填（#88）：经 attemptId 查同次尝试的 clip job，把上传产物以 mention_doc
  // 引用插到其文档开头。返回 { inserted: true } / { warning } / null（静默跳过）。
  // 不产生引用的静默情形：无 clip job（PDF 标签页直存云盘）、clip 失败终态无文档、
  // 已插过（pdfRefInserted 幂等标记，pdf job 重试/重跑不重复插入）。
  // clip 仍在建（非终态无 document）：之后 clip 建档不会补插（协议空隙，见
  // docs/job-protocol.md），记警告使可见，且不置位——pdf 重试届时可补插。
  // mark-before-insert：先置位再插入——租约过期被 recoverExpired 重排后，另一执行体
  // 拿不到 claimed 即跳过，不双插；置位失败（store 异常）直接抛出，不插入。
  // 插入失败清除标记后抛出，由上层记警告，重试可补插——清除与插入分属两个 try，
  // 置位/清除失败不会被误报为「插入失败」
  async #insertPdfReference(job, uploaded, name) {
    const clip = await this.store.get(job.attemptId, JOB_KIND.CLIP);
    if (!clip) return null;
    if (!clip.document?.documentId) {
      return CLIP_DOC_PENDING_STATUSES.has(clip.status) ? { warning: 'clip 文档尚未建好，PDF 引用未插入' } : null;
    }
    if (clip.pdfRefInserted) return null;
    const inserted = await this.#claimAndInsertPdfReference(job.attemptId, clip.document.documentId, uploaded, name);
    return inserted ? { inserted: true } : null;
  }

  // mark-before-insert 共享核（#88 pdf 侧 / #93 clip 侧）：原子置位抢到插入权才插，
  // 两侧竞态不双插；插入失败清标记后抛出（重试可补插）。true=已插入 / false=未抢到
  async #claimAndInsertPdfReference(attemptId, documentId, uploaded, name) {
    const { claimed } = await this.store.markPdfRefInserted(attemptId);
    if (!claimed) return false;
    try {
      await this.lark.insertDocFileReference({
        documentId,
        fileToken: uploaded.fileToken,
        fileUrl: uploaded.url,
        name,
      });
    } catch (error) {
      await this.store.markPdfRefInserted(attemptId, false).catch(() => {});
      throw error;
    }
    return true;
  }

  // PDF 引用补插（#93）：#91 并行后 pdf 通常先于 clip 建档完成，pdf 侧按「clip 未建好」
  // 跳过（#88 协议空隙成常态）；clip 建档完成后反向检查——pdf 已 succeeded 且未插过则补插。
  // 插入失败只记警告，job 不失败
  async #backfillPdfReference(job, document, warnings, timeline) {
    const pdfJob = await this.store.get(job.attemptId, JOB_KIND.PDF).catch(() => null);
    if (pdfJob?.status !== JOB_STATUS.SUCCEEDED || !pdfJob.document?.fileToken) return;
    if (job.pdfRefInserted) return;
    // 引用名与 pdf 侧同一命名规则，优先取 pdf job 的标题/来源（即实际上传名）
    const name = pdfFileName({ title: pdfJob.title ?? job.snapshot?.title, url: pdfJob.pdfSource?.url, fallback: pdfJob.pdfSource?.name });
    const refAt = Date.now();
    try {
      const inserted = await this.#claimAndInsertPdfReference(job.attemptId, document.documentId, pdfJob.document, name);
      if (inserted) timeline.push({ kind: 'stage', name: 'pdf_ref_insert', ms: Date.now() - refAt });
    } catch (error) {
      timeline.push({ kind: 'stage', name: 'pdf_ref_insert', ms: Date.now() - refAt, detail: String(error?.message || error).slice(0, 300) });
      warnings.push(`PDF 云盘引用插入失败：${error?.message || '未知错误'}`);
    }
  }

  // {{@file}} 凭据回退（#80）：digest 下载撞 401/403 后，把排队中的 url 型 pdf job 转
  // awaiting_bytes（store.requestBytes，幂等），有界轮询等扩展喂齐 staging——server 端整验
  // 通过后 markBytesReady 把 pdf job 放回 queued（bytes 声明粘滞），这里据此读 staging 字节。
  // 双通道并行（#91）后 pdf job 可能已在 running（自身下载同样会撞 401/403 转 awaiting_bytes），
  // requestBytes 被拒时若其处于 running/awaiting_bytes 则照旧进轮询等待，不立即降级。
  // clip 只读不 discard：staging 仍由 pdf job 后续消费上传云盘并收尾清理。
  // 返回 { buffer } 或 { warning }：预算耗尽 / pdf job 终态 / 声明超 32 MB / 整验失败都放弃，
  // 由调用方按 #79 降级语义记警告走纯文本。每轮 heartbeat 防 lease 过期被 sweep 重排
  async #awaitStagedPdf(job, workerId) {
    try {
      await this.store.requestBytes(job.attemptId);
    } catch {
      // 双通道并行（#91）后 pdf job 可能正在 running——它自身下载也会撞 401/403 并转
      // awaiting_bytes（#68），等它转入可喂字节状态即可，不立即降级；其余状态照旧放弃
      const pdfJob = await this.store.get(job.attemptId, JOB_KIND.PDF).catch(() => null);
      if (!pdfJob || (pdfJob.status !== JOB_STATUS.RUNNING && pdfJob.status !== JOB_STATUS.AWAITING_BYTES)) {
        return { warning: 'PDF 下载需要登录凭据，但 PDF 任务当前状态无法接收字节回传，已按纯文本生成摘要' };
      }
    }
    for (let waited = 0; waited < this.digestPdfWaitMs; waited += DIGEST_PDF_POLL_MS) {
      // heartbeat 失败（租约丢失/存储异常）时按降级退出，不让异常逃逸成 clip job 失败——
      // 租约真丢时后续 recordDigest 的租约守卫仍会拦下写入
      try {
        await this.store.heartbeat(job.attemptId, workerId);
      } catch {
        return { warning: '等待 PDF 字节期间任务租约异常，已按纯文本生成摘要' };
      }
      const pdfJob = await this.store.get(job.attemptId, JOB_KIND.PDF);
      if (!pdfJob || PDF_GIVE_UP_STATUSES.has(pdfJob.status)) {
        return { warning: `PDF 任务已结束（${pdfJob?.status ?? 'missing'}），无法取得 PDF 字节，已按纯文本生成摘要` };
      }
      if (pdfJob.pdfSource?.type === 'bytes') {
        // 声明一落库就能判超限，不必等喂齐
        if (pdfJob.pdfSource.sizeBytes > AI_FILE_MAX_BYTES) {
          return { warning: 'PDF 超过 AI 附件上限（32 MB），已按纯文本生成摘要' };
        }
        if (pdfJob.status === JOB_STATUS.QUEUED) {
          // awaiting_bytes → queued 即 markBytesReady（server 已整验）；读前按声明再验一次，
          // 防半途文件/并发写
          try {
            const filePath = await this.staging.verify(job.attemptId, pdfJob.pdfSource);
            return { buffer: await readFile(filePath) };
          } catch {
            return { warning: 'PDF 字节校验失败，已按纯文本生成摘要' };
          }
        }
      }
      await this.sleep(DIGEST_PDF_POLL_MS);
    }
    return { warning: '等待 PDF 字节回传超时，已按纯文本生成摘要' };
  }

  // 收尾「建档歧义」（create 超时但服务端可能已建出，协议见 docs/job-protocol.md）：
  // 命中（正文带本尝试标记）→ 记录 document 重排 write_body；确认未建 → 重排 create_document；
  // 单个任务查证失败不拖累其他任务，保持 reconciling 等下轮 sweep 或 TTL 兜底。
  // 重排由调用方（server 的 sweep）随后 kick 消费，这里不直接 kick，便于测试只观察状态迁移
  async reconcile() {
    if (this.reconcileRunning) return;
    this.reconcileRunning = true;
    try {
      const jobs = await this.store.list({ statuses: [JOB_STATUS.RECONCILING, JOB_STATUS.CANCEL_PENDING_RECONCILIATION] });
      for (const job of jobs) {
        try {
          const document = await this.#findCreatedDocument(job);
          await this.store.resolveAmbiguousCreate(job.attemptId, { document });
          this.logger.log?.('reconcile resolved', { attemptId: job.attemptId, found: document !== null });
        } catch (error) {
          this.logger.warn('reconcile failed', { attemptId: job.attemptId, error: error?.message || String(error) });
        }
      }
    } finally {
      this.reconcileRunning = false;
    }
  }

  // 在目的地 wiki 反查本尝试建出的文档：同名 docx 节点 + 正文含尝试标记才算命中。
  // 无标记的同名文档（空文档/别人的同名档/别的尝试）无法确证归属，一律按未建处理——
  // 极端情况下（space 目标 node-create 自身超时）会留下空同名孤儿节点，人工删除即可
  async #findCreatedDocument(job) {
    const spaceId = job.destination?.spaceId;
    if (!spaceId) throw new Error('任务目的地缺少 spaceId，无法查证');
    const title = safeTitle(job.snapshot?.title);
    const marker = `${ATTEMPT_MARKER_PREFIX}${job.attemptId}`;
    const parentNodeToken = job.destination?.kind === 'node' ? job.destination?.nodeToken : null;
    const nodes = [];
    let pageToken = null;
    for (let page = 0; page < 20; page += 1) {
      const args = ['wiki', '+node-list', '--as', 'user', '--space-id', spaceId, '--page-size', '50', '--format', 'json'];
      if (parentNodeToken) args.push('--parent-node-token', parentNodeToken);
      if (pageToken) args.push('--page-token', pageToken);
      const result = await this.lark.run(args, { timeoutMs: 30_000 });
      const data = result.data || {};
      nodes.push(...(data.nodes || []));
      pageToken = data.has_more === true ? data.page_token || null : null;
      if (!pageToken) break;
    }
    // 创建时间窗锚在 job.createdAt 前后（create 调用最多跑满本地超时 + 服务端导入滞后），
    // 排除同名老文档，也省得对无关候选拉正文；node-list 不带创建时间，逐候选 node-get 补齐
    const windowStart = (job.createdAt ?? 0) - 120_000;
    const windowEnd = (job.createdAt ?? 0) + 20 * 60_000;
    const candidates = nodes.filter((node) => node.obj_type === 'docx' && node.title === title && node.obj_token);
    for (const candidate of candidates) {
      const detail = await this.lark.run(['wiki', '+node-get', '--as', 'user', '--node-token', candidate.node_token, '--format', 'json'], { timeoutMs: 30_000 });
      const node = detail.data?.node || detail.data || {};
      const createdMs = Number(node.obj_create_time) * 1000;
      if (!Number.isFinite(createdMs) || createdMs < windowStart || createdMs > windowEnd) continue;
      const fetched = await this.lark.run(['docs', '+fetch', '--as', 'user', '--doc', candidate.obj_token, '--format', 'json'], { timeoutMs: 30_000 });
      // 标记在文档元信息引用块里，截断不影响判定，还能省掉大文档的全量驻留
      const content = String(fetched.data?.document?.content || '').slice(0, 20_000);
      if (content.includes(marker)) {
        // node-list 不返回文档 URL，按 wiki 节点惯例拼（本项目只面向 feishu.cn 租户）
        return { documentId: candidate.obj_token, url: `https://my.feishu.cn/wiki/${candidate.node_token}` };
      }
    }
    return null;
  }

  async #execute(job) {
    const workerId = randomUUID();
    await this.store.claim(job.attemptId, workerId);
    const scratch = await mkdtemp(path.join(tmpdir(), 'feishu-clip-'));
    // 长阶段（digest/下载/CLI）期间周期续约（#89），收尾 finally 停表；挂在 mkdtemp
    // 之后，防建目录抛错时计时器泄漏、持续给未进入 try 的死任务续约
    const lease = this.#startHeartbeat(job.attemptId, workerId);
    let document = job.document;
    // 耗时埋点：全程在内存收集，终态随 complete/fail 一次性落盘——
    // 逐条写会让 jobs.json（内含大 snapshot）被整本重写几十次
    const startedAt = Date.now();
    const timeline = [];
    const timing = () => ({ timeline, totalMs: Date.now() - startedAt });
    // 装饰 lark.run：每次 CLI 调用记一条 { kind:'cli', name=前两个 token }，
    // detail 只留截断的错误消息，不带正文内容/密钥
    const run = async (args, options) => {
      // 租约已丢就不再发起新的 CLI 调用（#89）：防 lease 丢失后还建出文档/上传媒体
      this.#assertLease(lease);
      const at = Date.now();
      const name = args.slice(0, 2).join(' ');
      try {
        const result = await this.lark.run(args, options);
        timeline.push({ kind: 'cli', name, ms: Date.now() - at });
        return result;
      } catch (error) {
        timeline.push({ kind: 'cli', name, ms: Date.now() - at, detail: String(error?.message || error).slice(0, 300) });
        throw error;
      }
    };
    try {
      // 任务级图片写入模式：合法三态直用；存量任务只有 includeImages 布尔，false → off，其余 → preview
      const imageMode = IMAGE_MODES.includes(job.imageMode) ? job.imageMode : (job.includeImages === false ? 'off' : 'preview');
      // AI 摘要阶段（#75）：建档（prepareMarkdown/create_document）之前对正文生成摘要。
      // 开关关 → 整段跳过；digestText 已落库 → 直接复用缓存不调 AI（#72-8，重跑安全）；
      // 失败绝不 fail job——记 timeline + 警告（与图片警告同一通道并入 complete 的 warnings，
      // 部分成功降级 #72-7），占位符置空/默认布局省略由 applyDigest 保证。
      // provider（#78）：digest.provider 非空 = 按名取该 provider；为空调 getAiConfig(null) 走
      // 默认 provider。按名取不到（被删/bridge 未配置）→ 不调 AI，warning 指明 provider 名
      const digestWarnings = [];
      let digestText = job.digestText ?? null;
      if (job.digest?.enabled && digestText === null) {
        const digestAt = Date.now();
        const providerName = typeof job.digest.provider === 'string' && job.digest.provider ? job.digest.provider : null;
        const config = await this.getAiConfig(providerName);
        if (providerName && !config) {
          timeline.push({ kind: 'stage', name: 'digest', ms: Date.now() - digestAt, detail: `provider「${providerName}」不存在` });
          digestWarnings.push(`AI provider「${providerName}」不存在（可能已被删除），本次未生成摘要`);
        } else {
          // {{@file}}（#79）：指令检出占位符时把本次剪藏的 url 型 PDF 作为附件随请求发出——
          // executor 在调 AI 前自行下载字节（复用 image-policy 的 SSRF/逐跳校验 + 100 MiB 硬上限，
          // 与 pdf job 同一下载函数）。无可用 PDF / 下载失败 / 超 32 MB 附件上限都静默去文件、
          // 按纯文本摘要执行并记一条警告（不算失败）；占位符剥除在 generateDigest 内完成
          let pdf;
          // 直接下载与 staging 回退两条路径共用同一份附件构造
          const toPdfAttachment = (buffer) => ({
            filename: pdfFileName({ title: job.snapshot?.title, url: job.pdfSource.url, fallback: job.pdfSource.name }),
            dataBase64: buffer.toString('base64'),
          });
          if (hasFilePlaceholder(job.digest.instruction)) {
            if (job.pdfSource?.type === 'url') {
              try {
                // 字节共享（#94）：pdf 通道已下载/在下载同一 URL 时优先复用，免第二次下载；
                // 共享被拒（pdf 失败）或超时回退自己下载（#92 重试 + 节点轮转）；
                // 凭据语义拒绝抛 401 形状错误，直接进下方 #80 staging 分支
                const shareAt = Date.now();
                const shared = await this.#awaitSharedPdf(job);
                if (shared) timeline.push({ kind: 'stage', name: 'pdf_share', ms: Date.now() - shareAt, detail: '复用 pdf 任务已下载字节' });
                const fetched = shared ?? await withTransientRetry((attempt) => this.downloadPdf(job.pdfSource.url, { attempt }), {
                  sleep: this.sleep,
                  onRetry: (error, attempt) => timeline.push({ kind: 'retry', name: 'pdf_download', detail: `${error?.code || error?.message}，第 ${attempt} 次重试（摘要附件）` }),
                });
                if (fetched.buffer.length > AI_FILE_MAX_BYTES) {
                  digestWarnings.push('PDF 超过 AI 附件上限（32 MB），已按纯文本生成摘要');
                } else {
                  pdf = toPdfAttachment(fetched.buffer);
                }
              } catch (error) {
                // 凭据回退（#80）：401/403 时转 staging 等待路径，复用扩展喂给 pdf job 的
                // 同一份字节；其余下载失败维持 #79 降级语义
                if (needsCredentialFallback(error) && this.staging) {
                  const staged = await this.#awaitStagedPdf(job, workerId);
                  if (staged.buffer) {
                    pdf = toPdfAttachment(staged.buffer);
                  } else {
                    digestWarnings.push(staged.warning);
                  }
                } else {
                  digestWarnings.push(`PDF 下载失败（${pdfErrorMessage(error)}），已按纯文本生成摘要`);
                }
              }
            } else {
              digestWarnings.push('摘要指令含 {{@file}} 但本次剪藏没有可用 PDF，已按纯文本生成摘要');
            }
          }
          // 长下载/等 staging 之后、调 AI 之前先确认租约仍在（#89）
          this.#assertLease(lease);
          // 摘要进度（#86）：流式 delta 经 onProgress 逐次更新内存条目（纯赋值）；
          // 初始相位 thinking——模型先思考后写正文，非 reasoning 模型首个正文 delta 即翻 writing
          const progress = { phase: 'thinking', tokens: 0 };
          this.digestProgress.set(job.attemptId, progress);
          try {
            digestText = await this.generateDigest({
              config, instruction: job.digest.instruction, content: job.snapshot.markdown,
              ...(pdf ? { pdf } : {}),
              onProgress: (update) => { progress.phase = update.phase; progress.tokens = update.tokens; },
            });
            // AI 返回后、写缓存前再确认一次：摘要动辄几分钟，租约可能在此期间被收走
            this.#assertLease(lease);
            await this.store.recordDigest(job.attemptId, workerId, digestText);
            // 正向可见性：成功也记录附件情况，任务日志可直接看到「这次有没有带 PDF」（此前只能靠输出猜）
            timeline.push({ kind: 'stage', name: 'digest', ms: Date.now() - digestAt, detail: pdf ? `已附 PDF（${pdf.filename}，${(pdf.dataBase64.length * 0.75 / 1048576).toFixed(1)} MB）` : '纯文本摘要' });
          } catch (error) {
            if (error.code === 'LEASE_LOST') throw error;
            timeline.push({ kind: 'stage', name: 'digest', ms: Date.now() - digestAt, detail: String(error?.message || error).slice(0, 300) });
            digestWarnings.push(`AI 摘要生成失败：${aiErrorMessage(error)}`);
          }
        }
      }
      const prepared = prepareMarkdown(
        { ...job.snapshot, markdown: applyDigest(job.snapshot.markdown, job.digest?.enabled ? digestText : null) },
        job.attemptId, { imageMode },
      );
      if (!document) {
        const createStageAt = Date.now();
        await this.store.beginCreate(job.attemptId, workerId);
        const contentPath = path.join(scratch, 'content.md');
        try {
          await writeFile(contentPath, prepared.markdown, 'utf8');
          if (job.destination.kind === 'space') {
            // 空间根目标走两步：先在空间根层创建空 docx 节点，再整体写入 Markdown 正文
            const node = await run([
              'wiki', '+node-create', '--as', 'user', '--space-id', job.destination.spaceId,
              '--obj-type', 'docx', '--title', safeTitle(job.snapshot.title), '--format', 'json',
            ], { cwd: scratch });
            document = parseCreatedNode(node);
            // 新建节点正文为空，append 等价于整体写入，且不会把正文首个 H1 提升为文档标题
            await run([
              'docs', '+update', '--as', 'user', '--doc', document.documentId,
              '--command', 'append', '--doc-format', 'markdown',
              '--content', '@content.md', '--format', 'json',
            ], { cwd: scratch, timeoutMs: 120_000 });
          } else {
            const created = await run([
              'docs', '+create', '--as', 'user', '--parent-token', job.destination.nodeToken,
              '--title', safeTitle(job.snapshot.title), '--doc-format', 'markdown',
              '--content', '@content.md', '--format', 'json',
            ], { cwd: scratch, timeoutMs: 120_000 });
            document = parseDocument(created);
          }
        } catch (error) {
          // 空间目标的两步合并为一个 create_document 阶段；失败也要先记阶段再落盘
          // 租约丢失（#89）不记阶段不落库，直接抛给外层 catch 安静收尾
          if (error.code === 'LEASE_LOST') throw error;
          timeline.push({ kind: 'stage', name: 'create_document', ms: Date.now() - createStageAt });
          // 服务端超时与本地超时一样可能「实际已建出文档」：无文档句柄时都按建档歧义处理
          if ((error.code === 'LARK_TIMEOUT' || isServerTimeout(error)) && !document) {
            await this.store.markCreateAmbiguous(job.attemptId, workerId);
            return;
          }
          if (document) await this.store.recordDocument(job.attemptId, workerId, document);
          await this.store.fail(job.attemptId, workerId, { stage: FAILURE_STAGE.CREATE_DOCUMENT, error: error.message, ...timing() });
          return;
        }
        await this.store.recordDocument(job.attemptId, workerId, document);
        timeline.push({ kind: 'stage', name: 'create_document', ms: Date.now() - createStageAt });
      }

      // digest 警告（#75/#79）与图片/iframe 警告同一通道，随 complete 落库呈现为部分成功
      const warnings = [...digestWarnings];
      // PDF 引用补插（#93）：#91 并行后 pdf 常先于 clip 建档完成，这里反向补插
      if (document) await this.#backfillPdfReference(job, document, warnings, timeline);
      let totalBytes = 0;
      // 图片/iframe 两个阶段共用的文档块操作辅助（原图片阶段内部函数提升）：
      // 频控退避、原生块 API 调用、全量块拉取、占位符文本替换
      const apiRaw = (method, apiPath, extra = []) =>
        run(['api', method, apiPath, ...extra, '--format', 'json'], { timeoutMs: 15_000 });
      // 频控（429/99991400）带抖动的指数退避，最多重试 2 次；其他错误直接抛
      const withBackoff = async (fn) => {
        for (let attempt = 0; ; attempt += 1) {
          try { return await fn(); } catch (error) {
            const text = `${error?.code || ''} ${error?.message || ''}`;
            if (attempt >= 2 || !/429|99991400/.test(text)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt + Math.random() * 300));
          }
        }
      };
      const api = (method, apiPath, extra = []) => withBackoff(() => apiRaw(method, apiPath, extra));
      const removeRange = (parentId, start, end) =>
        api('DELETE', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${parentId}/children/batch_delete`, [
          '--params', '{"document_revision_id":"-1"}', '--data', JSON.stringify({ start_index: start, end_index: end }),
        ]);
      // 一次全量块拉取定位所有锚点，取代旧流程每锚点的 keyword 探测（14 图约 22s）；
      // 锚点段落无论在哪（顶层/表格单元格/引用里），父块与下标都能直接算出来
      const listBlocks = async () => {
        const blocks = [];
        let pageToken = null;
        do {
          const params = { page_size: 500 };
          if (pageToken) params.page_token = pageToken;
          const page = await api('GET', `/open-apis/docx/v1/documents/${document.documentId}/blocks`, ['--params', JSON.stringify(params)]);
          blocks.push(...(page.data?.items || []));
          pageToken = page.data?.has_more ? page.data?.page_token || null : null;
        } while (pageToken);
        return blocks;
      };
      // str_replace 只用于降级路径：把残留占位符换成可读的链接文本，正文不留占位符
      const replaceMarker = async (marker, replacement) => {
        await run([
          'docs', '+update', '--as', 'user', '--doc', document.documentId,
          '--command', 'str_replace', '--doc-format', 'markdown',
          '--pattern', marker, '--content', replacement, '--format', 'json',
        ], { timeoutMs: 15_000 });
      };
      if (imageMode !== 'off') {
        const imagesStageAt = Date.now();
        try {
          // 图片三级降级（优先级：预览块 → 下载上传 → 纯链接，取代 #45 内联导入——
          // 内联靠飞书服务端下载，挂死图会打满 30s 导入预算，且不可达图无救）：
          // 写入分阶段：预览块串行 → 下载并行 → 建块串行 → 上传并行 → 绑定删锚点串行（#46）。
          // download 模式（#53）跳过预览块 pass：公开图片也一律进下载管线。180s 上限对剩余场景留足余量
          const deadline = Date.now() + 180_000;
          const anchorOf = (index) => `[[FEISHU_CLIP_IMAGE:${index}]]`;
          const replaceAnchor = (index, replacement) => replaceMarker(anchorOf(index), replacement);
          const dimensionsOf = (item) => (item.size ? { width: item.size.width, height: item.size.height } : {});

          const failures = new Map();
          const recordFailure = (index, message, ms) => {
            failures.set(index, message);
            timeline.push({ kind: 'image', name: `image-${index + 1}`, ms, detail: message });
          };

          const queue = prepared.images.map((image, index) => ({ image, index }));
          const markers = prepared.images.map((_, index) => anchorOf(index));
          let anchors = queue.length ? locateAnchors(await listBlocks(), markers) : [];

          // 第一级：预览块。原图 URL 直出为 iframe 块（block_type 26），查看者浏览器渲染，
          // 不下载不上传——最快最稳；服务端/桥都不可达的图（Medium miro）也能显示。
          // 建块是文档操作必须串行；同父块内按下标倒序，对其余锚点下标中性。
          // 建块失败或锚点定位不到的转入第二级下载管线（锚点仍在原位）；
          // download 模式整级跳过，公开图从下载管线起算
          const downloadQueue = imageMode === 'download' ? [...queue] : queue.filter(({ image }) => !safeHttpUrl(image.source));
          const previewable = imageMode === 'download' ? [] : queue.filter(({ image }) => safeHttpUrl(image.source));
          const locatedPreview = previewable.filter(({ index }) => anchors[index])
            .sort((a, b) => (anchors[a.index].parentId === anchors[b.index].parentId ? anchors[b.index].index - anchors[a.index].index : a.index - b.index));
          for (const item of locatedPreview) {
            const anchor = anchors[item.index];
            const at = Date.now();
            try {
              if (Date.now() >= deadline) throw new Error('图片阶段超过 180 秒');
              await api('POST', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${anchor.parentId}/children`, [
                '--params', '{"document_revision_id":"-1"}',
                '--data', JSON.stringify({
                  index: anchor.index,
                  children: [{ block_type: 26, iframe: { component: { iframe_type: 99, url: encodeURIComponent(safeHttpUrl(item.image.source)) } } }],
                }),
              ]);
              await removeRange(anchor.parentId, anchor.index + 1, anchor.index + 2);
              timeline.push({ kind: 'image', name: `image-${item.index + 1}`, ms: Date.now() - at, detail: 'iframe-preview' });
            } catch (error) {
              timeline.push({ kind: 'image', name: `image-${item.index + 1}`, ms: Date.now() - at, detail: `预览块失败转下载：${String(error?.message || error).slice(0, 120)}` });
              downloadQueue.push(item);
            }
          }
          downloadQueue.push(...previewable.filter(({ index }) => !anchors[index]));

          // 第二级：下载上传。预览 pass 改过文档就重新拉块定位，避免锚点下标漂移
          if (locatedPreview.length && downloadQueue.length) {
            anchors = locateAnchors(await listBlocks(), markers);
          }

          // 下载保持 3 路并行（字节来自扩展缓存或公网，与文档版本无关）；
          // 文档修改必须串行——每次块操作都推进文档版本
          const downloaded = [];
          for (let start = 0; start < downloadQueue.length; start += 3) {
            const batch = downloadQueue.slice(start, start + 3);
            const downloads = await Promise.allSettled(batch.map(async ({ image, index }) => {
              const downloadAt = Date.now();
              try {
                if (Date.now() >= deadline) throw new Error('图片阶段超过 180 秒');
                const fetched = await imageBytes(image);
                totalBytes += fetched.buffer.length;
                if (totalBytes > IMAGE_LIMITS.maxTotalBytes) throw new Error('图片总量超过 40 MiB');
                const filePath = path.join(scratch, `image-${index + 1}.${fetched.metadata.extension}`);
                await writeFile(filePath, fetched.buffer);
                // 建块尺寸：snapshot 合法宽高优先，其次从字节解析；都没有则留空块（老行为）
                const size = snapshotDimensions(image) || parseImageDimensions(fetched.buffer);
                return { index, filePath, size, downloadMs: Date.now() - downloadAt };
              } catch (error) {
                error.index = index;
                error.downloadMs = Date.now() - downloadAt;
                throw error;
              }
            }));
            for (const result of downloads) {
              if (result.status === 'rejected') {
                recordFailure(result.reason?.index, result.reason?.message || '处理失败', result.reason?.downloadMs || 0);
              } else {
                downloaded.push(result.value);
              }
            }
          }

          // 图片块插在锚点下标处，锚点顺延一位后被删——对其余锚点下标中性；
          // 同一父块内再按倒序处理，双保险
          const nativeItems = downloaded.filter((item) => anchors[item.index]);
          nativeItems.sort((a, b) => {
            const anchorA = anchors[a.index];
            const anchorB = anchors[b.index];
            return anchorA.parentId === anchorB.parentId ? anchorB.index - anchorA.index : a.index - b.index;
          });
          const timedOut = () => Date.now() >= deadline;
          const itemMs = (item, extra = 0) => (item.downloadMs || 0) + (item.createMs || 0) + (item.uploadMs || 0) + extra;

          // 分阶段写入（#46）：建块/绑定/删锚点是文档块操作，每次推进文档版本，必须串行；
          // 媒体上传走素材接口、不动文档版本，集中 3 路并行（对齐下载并发），把它从串行链里拿掉
          // 阶段一：串行建空图片块（带原始宽高，空块会固定 100x100）
          for (const item of nativeItems) {
            const createAt = Date.now();
            try {
              if (timedOut()) throw new Error('图片阶段超过 180 秒');
              const anchor = anchors[item.index];
              const created = await api('POST', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${anchor.parentId}/children`, [
                '--params', '{"document_revision_id":"-1"}',
                '--data', JSON.stringify({ index: anchor.index, children: [{ block_type: 27, image: dimensionsOf(item) }] }),
              ]);
              item.imageBlockId = created.data?.children?.[0]?.block_id;
              if (!item.imageBlockId) throw new Error('IMAGE_BLOCK_CREATE_FAILED');
              item.createMs = Date.now() - createAt;
            } catch (error) {
              recordFailure(item.index, error?.message || '处理失败', itemMs(item, Date.now() - createAt));
            }
          }
          // 阶段二：集中并行上传（lark-cli 要求 --file 是 cwd 内相对路径，传 basename）
          const uploadable = nativeItems.filter((item) => item.imageBlockId);
          for (let start = 0; start < uploadable.length; start += 3) {
            await Promise.all(uploadable.slice(start, start + 3).map(async (item) => {
              const uploadAt = Date.now();
              try {
                if (timedOut()) throw new Error('图片阶段超过 180 秒');
                const uploaded = await withBackoff(() => run([
                  'docs', '+media-upload', '--as', 'user', '--doc-id', document.documentId,
                  '--file', path.basename(item.filePath), '--parent-node', item.imageBlockId, '--parent-type', 'docx_image', '--format', 'json',
                ], { cwd: scratch, timeoutMs: 30_000 }));
                item.token = uploaded.data?.file_token;
                if (!item.token) throw new Error('IMAGE_UPLOAD_MISSING_TOKEN');
              } catch (error) {
                item.uploadError = error?.message || '处理失败';
              }
              item.uploadMs = Date.now() - uploadAt;
            }));
          }
          // 阶段三：串行绑定 token（replace_image 会把宽高重置回 100x100，尺寸随 token 再传一遍）
          // → 删锚点段落；上传失败的清掉空图片块，锚点留给统一回退。
          // 下标换算：阶段一已把同父块的所有图片块插入完毕，每个锚点都被「原始下标 ≤ 它」的
          // 同父图片块各顶右一位，所以锚点当前下标 = 原始下标 + 该数量（其图片块紧邻其前一位）。
          // 注意只数建块成功的：建块失败的锚点没有块顶位（审查发现的边界，勿改回按锚点数）
          const shiftOf = (item) => {
            const anchor = anchors[item.index];
            return nativeItems.filter((other) => other.imageBlockId && anchors[other.index].parentId === anchor.parentId && anchors[other.index].index <= anchor.index).length;
          };
          for (const item of nativeItems) {
            if (!item.imageBlockId) continue; // 建块就失败的没有块要清，锚点仍在原位
            const anchor = anchors[item.index];
            const shift = shiftOf(item);
            const bindAt = Date.now();
            try {
              if (!item.token) {
                await removeRange(anchor.parentId, anchor.index + shift - 1, anchor.index + shift);
                recordFailure(item.index, item.uploadError, itemMs(item, Date.now() - bindAt));
                continue;
              }
              if (timedOut()) throw new Error('图片阶段超过 180 秒');
              await api('PATCH', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${item.imageBlockId}`, [
                '--params', '{"document_revision_id":"-1"}', '--data', JSON.stringify({ replace_image: { token: item.token, ...dimensionsOf(item) } }),
              ]);
              await removeRange(anchor.parentId, anchor.index + shift, anchor.index + shift + 1);
              const bindMs = Date.now() - bindAt;
              timeline.push({
                kind: 'image', name: `image-${item.index + 1}`, ms: itemMs(item, bindMs),
                detail: `download ${item.downloadMs}ms / create ${item.createMs}ms / upload ${item.uploadMs}ms / bind ${bindMs}ms`,
              });
            } catch (error) {
              // 半途失败会留下空图片块，尽力清掉再交给上层回退
              await removeRange(anchor.parentId, anchor.index + shift - 1, anchor.index + shift).catch(() => {});
              recordFailure(item.index, error?.message || '处理失败', itemMs(item, Date.now() - bindAt));
            }
          }

          // 定位不到独立块的锚点（混在列表项/代码块文本中间）回退旧路径：media-insert
          // 按文本匹配顶层插入 + str_replace 抹锚点。media-insert 会移动顶层下标、
          // str_replace 会重建表格使块 id 失效，所以必须排在所有原生块操作之后
          for (const item of downloaded.filter((entry) => !anchors[entry.index])) {
            const writeAt = Date.now();
            try {
              if (Date.now() >= deadline) throw new Error('图片阶段超过 180 秒');
              await run([
                'docs', '+media-insert', '--as', 'user', '--doc', document.documentId,
                '--file', path.basename(item.filePath), '--type', 'image',
                '--selection-with-ellipsis', anchorOf(item.index), '--format', 'json',
              ], { cwd: scratch, timeoutMs: 30_000 });
              await replaceAnchor(item.index, '');
              timeline.push({ kind: 'image', name: `image-${item.index + 1}`, ms: item.downloadMs + Date.now() - writeAt });
            } catch (error) {
              recordFailure(item.index, error?.message || '处理失败', item.downloadMs + Date.now() - writeAt);
            }
          }

          // 全部处理完后统一回退：失败的锚点 str_replace 成可读文案（含原图链接）。
          // 预览块已是第一级（见上，download 模式跳过），走到这里的图要么没有公开 URL、
          // 要么预览/下载都失败，只剩文本兜底
          for (const [index, message] of [...failures.entries()].sort((a, b) => a[0] - b[0])) {
            warnings.push(`图片 ${index + 1}：${message}`);
            const image = prepared.images[index];
            const label = escapeMarkdown(image.label || `图片 ${index + 1}`);
            const source = safeHttpUrl(image.source);
            const fallback = source ? `图片：${label}（[原图链接](${source})）` : `图片：${label}`;
            try {
              await replaceAnchor(index, fallback);
            } catch (fallbackError) {
              this.logger.warn('图片锚点回退失败，文档残留占位符', { attemptId: job.attemptId, index, error: fallbackError.message });
            }
          }
        } finally {
          timeline.push({ kind: 'stage', name: 'images', ms: Date.now() - imagesStageAt });
        }
      }

      // iframe 阶段（#48）：占位符段落转写为飞书 iframe 块（block_type 26，与用户手动
      // 「预览视图」同型；spike 实测 children API 可创建，url 需 encodeURIComponent）。
      // 与图片锚点同构：建块插在锚点下标处、锚点顺延一位后删除；同父块内按下标倒序处理。
      // 建块失败或锚点定位不到时降级为 [title](url) 链接段落，计入警告，不静默丢弃
      const iframeItems = Array.isArray(job.snapshot.iframes) ? job.snapshot.iframes.slice(0, 10) : [];
      if (iframeItems.length) {
        const iframesStageAt = Date.now();
        const settledIframes = new Set(); // 已处理（建块或降级）的下标，兜底 catch 不重复降级
        // markers/linkText/degrade 须在 try 外声明：listBlocks 抛错时 catch 里还要用它们降级，
        // 声明在 try 内会因 TDZ 再抛 ReferenceError（测试里表现为假 store 无限重试挂起）
        const markers = iframeItems.map((_, index) => `[[FEISHU_CLIP_IFRAME:${index}]]`);
        const linkText = (index) => {
          const label = escapeMarkdown(iframeItems[index].title || `iframe ${index + 1}`);
          const source = safeHttpUrl(iframeItems[index].url);
          return source ? `[${label}](${source})` : label;
        };
        const degrade = async (index, message) => {
          settledIframes.add(index);
          warnings.push(`iframe「${iframeItems[index].title || `iframe ${index + 1}`}」：${message}`);
          try {
            await replaceMarker(markers[index], linkText(index));
          } catch (fallbackError) {
            this.logger.warn('iframe 占位符回退失败，文档残留占位符', { attemptId: job.attemptId, index, error: fallbackError.message });
          }
        };
        try {
          const anchors = locateAnchors(await listBlocks(), markers);
          const located = iframeItems.map((_, index) => index).filter((index) => anchors[index])
            .sort((a, b) => (anchors[a].parentId === anchors[b].parentId ? anchors[b].index - anchors[a].index : 0));
          for (const index of located) {
            const anchor = anchors[index];
            const at = Date.now();
            try {
              await api('POST', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${anchor.parentId}/children`, [
                '--params', '{"document_revision_id":"-1"}',
                '--data', JSON.stringify({
                  index: anchor.index,
                  children: [{ block_type: 26, iframe: { component: { iframe_type: 99, url: encodeURIComponent(iframeItems[index].url) } } }],
                }),
              ]);
              await removeRange(anchor.parentId, anchor.index + 1, anchor.index + 2);
              settledIframes.add(index);
              timeline.push({ kind: 'iframe', name: `iframe-${index + 1}`, ms: Date.now() - at });
            } catch (error) {
              timeline.push({ kind: 'iframe', name: `iframe-${index + 1}`, ms: Date.now() - at, detail: String(error?.message || error).slice(0, 300) });
              await degrade(index, error?.message || '处理失败');
            }
          }
          for (const index of iframeItems.map((_, i) => i).filter((i) => !anchors[i])) {
            await degrade(index, '未能嵌入，保留原链接');
          }
        } catch (error) {
          // 整体性失败（如块列表拉取抛错）：不拖垮整个剪藏，剩余占位符全部降级为链接
          for (const index of iframeItems.map((_, i) => i).filter((i) => !settledIframes.has(i))) {
            await degrade(index, error?.message || '处理失败');
          }
        } finally {
          timeline.push({ kind: 'stage', name: 'iframes', ms: Date.now() - iframesStageAt });
        }
      }
      await this.store.complete(job.attemptId, workerId, { warnings, ...timing() });
    } catch (error) {
      if (error.code === 'LEASE_LOST') {
        // 租约已被收走：由接管的新执行体负责终态，这里只记日志不写库
        this.logger.warn?.('租约丢失，clip 执行中止', { attemptId: job.attemptId });
        return;
      }
      const current = await this.store.get(job.attemptId, JOB_KIND.CLIP);
      if (current?.status === JOB_STATUS.RUNNING && current.workerId === workerId) {
        await this.store.fail(job.attemptId, workerId, {
          stage: current.document ? FAILURE_STAGE.IMAGES : FAILURE_STAGE.CREATE_DOCUMENT,
          error: error.message || '剪藏处理失败',
          ...timing(),
        });
      }
      this.logger.error('clip attempt failed', { attemptId: job.attemptId, error });
    } finally {
      lease.stop();
      // 字节共享表收尾（#94）：clip 终态后条目不再有人消费，防泄漏
      this.pdfShares.delete(job.attemptId);
      // 摘要进度表收尾（#86）：终态后视图不再带 digestProgress
      this.digestProgress.delete(job.attemptId);
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
