import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FAILURE_STAGE, JOB_STATUS } from './job-store.mjs';
import { downloadPublicImage, IMAGE_LIMITS, parseImageDimensions, validateImageBytes } from './image-policy.mjs';

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
  // 拷贝一份再标记 inline，避免污染 job snapshot 里的原始对象（重建时要改标记重新生成）
  const images = Array.isArray(snapshot.images) ? snapshot.images.slice(0, IMAGE_LIMITS.maxImages).map((image) => ({ ...image })) : [];
  let body = String(snapshot.markdown || '').slice(0, 1_500_000);
  if (!includeImages) {
    // 不处理图片时锚点直接落成可读文本（含原图链接）；处理时保留锚点供 media-insert 定位
    for (const [index, image] of images.entries()) {
      const label = escapeMarkdown(image.label || `图片 ${index + 1}`);
      const source = safeHttpUrl(image.source);
      body = body.replaceAll(`[[FEISHU_CLIP_IMAGE:${index}]]`, source ? `图片：${label}（[原图链接](${source})）` : `图片：${label}`);
    }
    body = body.replace(/\[\[FEISHU_CLIP_IMAGE:\d+\]\]/g, '图片：未能处理');
  } else {
    // 内联 URL 管线（#45，spike 见 docs/research/inline-image-url-import.md）：
    // 无浏览器字节的公开图片写成 Markdown 图片语法，由飞书服务端在导入时下载成图片块；
    // 有字节的（同源/需凭证）保留锚点走上传管线；URL 不安全的直接降级为文本。
    // image.inline === false 是重建路径的强制标记：服务端下载失败的图转回锚点管线
    for (const [index, image] of images.entries()) {
      const anchor = `[[FEISHU_CLIP_IMAGE:${index}]]`;
      const label = escapeMarkdown(image.label || `图片 ${index + 1}`);
      const source = safeHttpUrl(image.source);
      if (!image.bytesBase64 && source && image.inline !== false) {
        image.inline = true;
        body = body.replaceAll(anchor, `![${label}](${source})`);
      } else if (!image.bytesBase64 && !source) {
        body = body.replaceAll(anchor, `图片：${label}`);
      }
    }
  }
  const source = safeHttpUrl(snapshot.sourceUrl);
  const metadata = [
    source ? `> 来源：[${escapeMarkdown(source)}](${source})` : '> 来源：不可用',
    `> 剪藏时间：${new Date(snapshot.capturedAt || Date.now()).toISOString()}`,
    `> 剪藏尝试：${attemptId}`,
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
// 不再需要每张图做 keyword 探测（旧流程 14 图约 22s）。
// 只接受独立成块的锚点（块文本 trim 后严格等于锚点）：混在列表项/代码块文本中间的
// 锚点若原生删除会把有内容的块误删，那种返回 null 由调用方走 media-insert 回退
function locateAnchors(items, count) {
  const byId = new Map(items.map((item) => [item.block_id, item]));
  const anchors = [];
  for (let index = 0; index < count; index += 1) {
    const marker = `[[FEISHU_CLIP_IMAGE:${index}]]`;
    const block = items.find((item) => blockText(item).trim() === marker);
    const parent = block ? byId.get(block.parent_id) : null;
    const at = parent?.children?.indexOf(block.block_id) ?? -1;
    anchors.push(block && parent && at >= 0 ? { blockId: block.block_id, parentId: parent.block_id, index: at } : null);
  }
  return anchors;
}

// 从 +create/+update 的 warnings 里提取服务端下载失败的图片 URL（degrade_code=2108）。
// spike 实测有两种报文格式，URL 后的收尾不一样：
// "...image URL: <url>, HTTP status: 404..." 和 "...image URL: <url>. Verify that..."
function degradedImageUrls(warnings) {
  const urls = new Set();
  for (const warning of warnings || []) {
    const text = String(warning);
    if (!text.includes('degrade_code=2108')) continue;
    const match = text.match(/image URL: (\S+)/);
    if (match) urls.add(match[1].replace(/[.,]$/, ''));
  }
  return urls;
}

export class ClipExecutor {
  constructor({ store, lark, logger = console }) {
    this.store = store;
    this.lark = lark;
    this.logger = logger;
    this.running = false;
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
      // prepared 可变：服务端下载失败的图片会翻转 inline 标记、删档重建后重新生成正文
      let prepared = prepareMarkdown(job.snapshot, job.attemptId, { includeImages: job.includeImages });
      if (!document) {
        const createStageAt = Date.now();
        await this.store.beginCreate(job.attemptId, workerId);
        const contentPath = path.join(scratch, 'content.md');
        try {
          // 最多重建一次：spike（docs/research/inline-image-url-import.md）实测服务端下载失败的
          // 图片在文档里无任何残留，无法文档内定位补插——只能删掉重建，失败图转回锚点上传管线
          let recreated = false;
          for (;;) {
            await writeFile(contentPath, prepared.markdown, 'utf8');
            const warnings = [];
            if (job.destination.kind === 'space') {
              // 空间根目标走两步：先在空间根层创建空 docx 节点，再整体写入 Markdown 正文
              const node = await run([
                'wiki', '+node-create', '--as', 'user', '--space-id', job.destination.spaceId,
                '--obj-type', 'docx', '--title', safeTitle(job.snapshot.title), '--format', 'json',
              ], { cwd: scratch });
              document = parseCreatedNode(node);
              // 新建节点正文为空，append 等价于整体写入，且不会把正文首个 H1 提升为文档标题
              const updated = await run([
                'docs', '+update', '--as', 'user', '--doc', document.documentId,
                '--command', 'append', '--doc-format', 'markdown',
                '--content', '@content.md', '--format', 'json',
              ], { cwd: scratch, timeoutMs: 120_000 });
              warnings.push(...(updated.data?.warnings || []));
            } else {
              const created = await run([
                'docs', '+create', '--as', 'user', '--parent-token', job.destination.nodeToken,
                '--title', safeTitle(job.snapshot.title), '--doc-format', 'markdown',
                '--content', '@content.md', '--format', 'json',
              ], { cwd: scratch, timeoutMs: 120_000 });
              document = parseDocument(created);
              warnings.push(...(created.data?.warnings || []));
            }
            const degraded = degradedImageUrls(warnings);
            const retry = prepared.images.filter((image) => image.inline && degraded.has(safeHttpUrl(image.source)));
            if (!retry.length || recreated) break;
            recreated = true;
            await run([
              'wiki', '+node-delete', '--node-token', document.documentId,
              '--obj-type', 'docx', '--as', 'user', '--yes', '--format', 'json',
            ], { timeoutMs: 30_000 });
            document = null;
            for (const image of retry) image.inline = false;
            prepared = prepareMarkdown({ ...job.snapshot, images: prepared.images }, job.attemptId, { includeImages: job.includeImages });
          }
        } catch (error) {
          // 空间目标的两步合并为一个 create_document 阶段；失败也要先记阶段再落盘
          timeline.push({ kind: 'stage', name: 'create_document', ms: Date.now() - createStageAt });
          if (error.code === 'LARK_TIMEOUT' && !document) {
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
      if (job.includeImages) {
        const imagesStageAt = Date.now();
        try {
          // 图片阶段只处理浏览器取了字节的图片（公开图已在导入时由服务端内联下载，#45）；
          // 写入分阶段：建块串行 → 上传并行 → 绑定删锚点串行（#46）。180s 上限对剩余场景留足余量
          const deadline = Date.now() + 180_000;
          const anchorOf = (index) => `[[FEISHU_CLIP_IMAGE:${index}]]`;
          // str_replace 只用于失败路径：把残留锚点换成可读的链接文本，正文不留占位符
          const replaceAnchor = async (index, replacement) => {
            await run([
              'docs', '+update', '--as', 'user', '--doc', document.documentId,
              '--command', 'str_replace', '--doc-format', 'markdown',
              '--pattern', anchorOf(index), '--content', replacement, '--format', 'json',
            ], { timeoutMs: 15_000 });
          };
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
          const dimensionsOf = (item) => (item.size ? { width: item.size.width, height: item.size.height } : {});

          // 内联图片（#45）已由飞书服务端在导入时下载，这里只留痕，不做任何逐图调用
          const partitioned = prepared.images.map((image, index) => ({ image, index }));
          const queue = partitioned.filter(({ image }) => !image.inline);
          for (const { index } of partitioned.filter(({ image }) => image.inline)) {
            timeline.push({ kind: 'image', name: `image-${index + 1}`, ms: 0, detail: 'inline-url' });
          }
          // 一次全量块拉取定位所有锚点，取代旧流程每张图的 keyword 探测（14 图约 22s）；
          // 锚点段落无论在哪（顶层/表格单元格/引用里），父块与下标都能直接算出来，
          // 插入统一走原生块操作，不再用 media-insert（14 图约 51s，且只能插顶层）
          const anchors = [];
          if (queue.length) {
            const blocks = [];
            let pageToken = null;
            do {
              const params = { page_size: 500 };
              if (pageToken) params.page_token = pageToken;
              const page = await api('GET', `/open-apis/docx/v1/documents/${document.documentId}/blocks`, ['--params', JSON.stringify(params)]);
              blocks.push(...(page.data?.items || []));
              pageToken = page.data?.has_more ? page.data?.page_token || null : null;
            } while (pageToken);
            anchors.push(...locateAnchors(blocks, prepared.images.length));
          }

          const failures = new Map();
          const recordFailure = (index, message, ms) => {
            failures.set(index, message);
            timeline.push({ kind: 'image', name: `image-${index + 1}`, ms, detail: message });
          };

          // 下载保持 3 路并行（字节来自扩展缓存或公网，与文档版本无关）；
          // 文档修改必须串行——每次块操作都推进文档版本
          const downloaded = [];
          for (let start = 0; start < queue.length; start += 3) {
            const batch = queue.slice(start, start + 3);
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

          // 全部处理完后统一回退：失败的锚点 str_replace 成可读文案（含原图链接）
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
