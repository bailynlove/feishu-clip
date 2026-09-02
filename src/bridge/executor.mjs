import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FAILURE_STAGE, JOB_STATUS } from './job-store.mjs';
import { downloadPublicImage, IMAGE_LIMITS, parseImageDimensions, validateImageBytes } from './image-policy.mjs';

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

function escapeMarkdown(value) {
  return String(value || '').replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

export function prepareMarkdown(snapshot, attemptId, { includeImages = false } = {}) {
  const images = Array.isArray(snapshot.images) ? snapshot.images.slice(0, IMAGE_LIMITS.maxImages).map((image) => ({ ...image })) : [];
  let body = String(snapshot.markdown || '').slice(0, 1_500_000);
  if (!includeImages) {
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
  constructor({ store, lark, logger = console }) {
    this.store = store;
    this.lark = lark;
    this.logger = logger;
    this.running = false;
    this.reconcileRunning = false;
  }

  kick() {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => this.#drain().finally(async () => {
      this.running = false;
      if ((await this.store.list({ statuses: [JOB_STATUS.QUEUED] })).length > 0) this.kick();
    }));
  }

  async #drain() {
    for (;;) {
      const [job] = await this.store.list({ statuses: [JOB_STATUS.QUEUED] });
      if (!job) return;
      await this.#execute(job).catch((error) => this.logger.error('clip worker failed', error));
    }
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
    let document = job.document;
    // 耗时埋点：全程在内存收集，终态随 complete/fail 一次性落盘——
    // 逐条写会让 jobs.json（内含大 snapshot）被整本重写几十次
    const startedAt = Date.now();
    const timeline = [];
    const timing = () => ({ timeline, totalMs: Date.now() - startedAt });
    // 装饰 lark.run：每次 CLI 调用记一条 { kind:'cli', name=前两个 token }，
    // detail 只留截断的错误消息，不带正文内容/密钥
    const run = async (args, options) => {
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
      const prepared = prepareMarkdown(job.snapshot, job.attemptId, { includeImages: job.includeImages });
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

      const warnings = [];
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
      if (job.includeImages) {
        const imagesStageAt = Date.now();
        try {
          // 图片三级降级（优先级：预览块 → 下载上传 → 纯链接，取代 #45 内联导入——
          // 内联靠飞书服务端下载，挂死图会打满 30s 导入预算，且不可达图无救）：
          // 写入分阶段：预览块串行 → 下载并行 → 建块串行 → 上传并行 → 绑定删锚点串行（#46）。
          // 180s 上限对剩余场景留足余量
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
          // 建块失败或锚点定位不到的转入第二级下载管线（锚点仍在原位）
          const downloadQueue = queue.filter(({ image }) => !safeHttpUrl(image.source));
          const previewable = queue.filter(({ image }) => safeHttpUrl(image.source));
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
          // 预览块已是第一级（见上），走到这里的图要么没有公开 URL、要么两级都失败，
          // 只剩文本兜底
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
      const current = await this.store.get(job.attemptId);
      if (current?.status === JOB_STATUS.RUNNING && current.workerId === workerId) {
        await this.store.fail(job.attemptId, workerId, {
          stage: current.document ? FAILURE_STAGE.IMAGES : FAILURE_STAGE.CREATE_DOCUMENT,
          error: error.message || '剪藏处理失败',
          ...timing(),
        });
      }
      this.logger.error('clip attempt failed', { attemptId: job.attemptId, error });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
