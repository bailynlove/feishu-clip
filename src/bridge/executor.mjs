import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FAILURE_STAGE, JOB_STATUS } from './job-store.mjs';
import { downloadPublicImage, IMAGE_LIMITS, validateImageBytes } from './image-policy.mjs';

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
  const images = Array.isArray(snapshot.images) ? snapshot.images.slice(0, IMAGE_LIMITS.maxImages) : [];
  let body = String(snapshot.markdown || '').slice(0, 1_500_000);
  if (!includeImages) {
    // 不处理图片时锚点直接落成可读文本（含原图链接）；处理时保留锚点供 media-insert 定位
    for (const [index, image] of images.entries()) {
      const label = escapeMarkdown(image.label || `图片 ${index + 1}`);
      const source = safeHttpUrl(image.source);
      body = body.replaceAll(`[[FEISHU_CLIP_IMAGE:${index}]]`, source ? `图片：${label}（[原图链接](${source})）` : `图片：${label}`);
    }
    body = body.replace(/\[\[FEISHU_CLIP_IMAGE:\d+\]\]/g, '图片：未能处理');
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
    try {
      const prepared = prepareMarkdown(job.snapshot, job.attemptId, { includeImages: job.includeImages });
      if (!document) {
        await this.store.beginCreate(job.attemptId, workerId);
        const contentPath = path.join(scratch, 'content.md');
        await writeFile(contentPath, prepared.markdown, 'utf8');
        try {
          if (job.destination.kind === 'space') {
            // 空间根目标走两步：先在空间根层创建空 docx 节点，再整体写入 Markdown 正文
            const node = await this.lark.run([
              'wiki', '+node-create', '--as', 'user', '--space-id', job.destination.spaceId,
              '--obj-type', 'docx', '--title', safeTitle(job.snapshot.title), '--format', 'json',
            ], { cwd: scratch });
            document = parseCreatedNode(node);
            // 新建节点正文为空，append 等价于整体写入，且不会把正文首个 H1 提升为文档标题
            await this.lark.run([
              'docs', '+update', '--as', 'user', '--doc', document.documentId,
              '--command', 'append', '--doc-format', 'markdown',
              '--content', '@content.md', '--format', 'json',
            ], { cwd: scratch });
          } else {
            const created = await this.lark.run([
              'docs', '+create', '--as', 'user', '--parent-token', job.destination.nodeToken,
              '--title', safeTitle(job.snapshot.title), '--doc-format', 'markdown',
              '--content', '@content.md', '--format', 'json',
            ], { cwd: scratch });
            document = parseDocument(created);
          }
        } catch (error) {
          if (error.code === 'LARK_TIMEOUT' && !document) {
            await this.store.markCreateAmbiguous(job.attemptId, workerId);
            return;
          }
          if (document) await this.store.recordDocument(job.attemptId, workerId, document);
          await this.store.fail(job.attemptId, workerId, { stage: FAILURE_STAGE.CREATE_DOCUMENT, error: error.message });
          return;
        }
        await this.store.recordDocument(job.attemptId, workerId, document);
      }

      const warnings = [];
      let totalBytes = 0;
      if (job.includeImages) {
        const deadline = Date.now() + 90_000;
        const anchorOf = (index) => `[[FEISHU_CLIP_IMAGE:${index}]]`;
        // media-insert 只会在锚点旁插入、不会删掉锚点本身，成功后用 str_replace 抹掉；
        // 失败的图片把锚点换成可读的链接文本，正文不留占位符
        const replaceAnchor = async (index, replacement) => {
          await this.lark.run([
            'docs', '+update', '--as', 'user', '--doc', document.documentId,
            '--command', 'str_replace', '--doc-format', 'markdown',
            '--pattern', anchorOf(index), '--content', replacement, '--format', 'json',
          ], { timeoutMs: 15_000 });
        };
        const api = (method, apiPath, extra = []) =>
          this.lark.run(['api', method, apiPath, ...extra, '--format', 'json'], { timeoutMs: 15_000 });
        const removeChildBlock = async (parentId, blockId) => {
          // 块删除只有 batch_delete（按下标区间），先查父块子列表定位
          const children = (await api('GET', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${parentId}/children`)).data?.items || [];
          const at = children.findIndex((child) => child.block_id === blockId);
          if (at < 0) return;
          await api('DELETE', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${parentId}/children/batch_delete`, [
            '--params', '{"document_revision_id":"-1"}', '--data', JSON.stringify({ start_index: at, end_index: at + 1 }),
          ]);
        };
        // 锚点落在表格单元格里时 media-insert 只能插到表格外（它钉在匹配块的顶层祖先），
        // 改走原生 API：单元格内建空图片块 → 上传媒体 → 绑定 token → 删掉锚段落。
        // 注意 str_replace 会重建整个表格、块 id 全部失效，所以锚点定位必须每次现查。
        // 返回 false 表示锚点不在单元格里，调用方回退到 media-insert 顶层插入。
        const insertCellImage = async (index, filePath) => {
          const located = await this.lark.run([
            'docs', '+fetch', '--as', 'user', '--doc', document.documentId,
            '--scope', 'keyword', '--keyword', anchorOf(index),
            '--detail', 'with-ids', '--doc-format', 'xml', '--format', 'json',
          ], { timeoutMs: 15_000 });
          const xml = String(located.data?.document?.content || '');
          const anchorId = xml.match(new RegExp(`<p id="([^"]+)">\\[\\[FEISHU_CLIP_IMAGE:${index}\\]\\]</p>`))?.[1];
          if (!anchorId) return false;
          let block = (await api('GET', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${anchorId}`)).data?.block;
          let cellId = null;
          for (let hops = 0; block && hops < 6; hops += 1) {
            if (block.block_type === 32) { cellId = block.block_id; break; }
            if (!block.parent_id || block.parent_id === block.block_id) break;
            block = (await api('GET', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${block.parent_id}`)).data?.block;
          }
          if (!cellId) return false;
          const children = (await api('GET', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${cellId}/children`)).data?.items || [];
          const at = children.findIndex((child) => child.block_id === anchorId);
          if (at < 0) return false;
          let imageBlockId = null;
          try {
            const created = await api('POST', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${cellId}/children`, [
              '--params', '{"document_revision_id":"-1"}',
              '--data', JSON.stringify({ index: at, children: [{ block_type: 27, image: {} }] }),
            ]);
            imageBlockId = created.data?.children?.[0]?.block_id;
            if (!imageBlockId) throw new Error('IMAGE_BLOCK_CREATE_FAILED');
            const uploaded = await this.lark.run([
              'docs', '+media-upload', '--as', 'user', '--doc-id', document.documentId,
              '--file', filePath, '--parent-node', imageBlockId, '--parent-type', 'docx_image', '--format', 'json',
            ], { timeoutMs: 30_000 });
            const token = uploaded.data?.file_token;
            if (!token) throw new Error('IMAGE_UPLOAD_MISSING_TOKEN');
            await api('PATCH', `/open-apis/docx/v1/documents/${document.documentId}/blocks/${imageBlockId}`, [
              '--params', '{"document_revision_id":"-1"}', '--data', JSON.stringify({ replace_image: { token } }),
            ]);
            await removeChildBlock(cellId, anchorId);
          } catch (error) {
            // 半途中失败会留下空图片块，尽力清掉再交给上层回退
            if (imageBlockId) await removeChildBlock(cellId, imageBlockId).catch(() => {});
            throw error;
          }
          return true;
        };
        for (let start = 0; start < prepared.images.length; start += 3) {
          const batch = prepared.images.slice(start, start + 3);
          // 下载阶段可并行；写文档阶段必须串行——每次插入都会改文档版本，
          // 并行的锚点定位会拿到失效的块 id
          const downloads = await Promise.allSettled(batch.map(async (image, offset) => {
            if (Date.now() >= deadline) throw new Error('图片阶段超过 90 秒');
            const index = start + offset;
            const fetched = await imageBytes(image);
            totalBytes += fetched.buffer.length;
            if (totalBytes > IMAGE_LIMITS.maxTotalBytes) throw new Error('图片总量超过 40 MiB');
            const filePath = path.join(scratch, `image-${index + 1}.${fetched.metadata.extension}`);
            await writeFile(filePath, fetched.buffer);
            return { index, filePath };
          }));
          for (const [offset, result] of downloads.entries()) {
            const index = start + offset;
            const image = batch[offset];
            let failure = result.status === 'rejected' ? result.reason : null;
            if (!failure) {
              try {
                const inserted = await insertCellImage(result.value.index, result.value.filePath);
                if (!inserted) {
                  await this.lark.run([
                    'docs', '+media-insert', '--as', 'user', '--doc', document.documentId,
                    '--file', path.basename(result.value.filePath), '--type', 'image',
                    '--selection-with-ellipsis', anchorOf(index), '--format', 'json',
                  ], { cwd: scratch, timeoutMs: 30_000 });
                  await replaceAnchor(index, '');
                }
              } catch (error) {
                failure = error;
              }
            }
            if (!failure) continue;
            warnings.push(`图片 ${index + 1}：${failure?.message || '处理失败'}`);
            const label = escapeMarkdown(image.label || `图片 ${index + 1}`);
            const source = safeHttpUrl(image.source);
            const fallback = source ? `图片：${label}（[原图链接](${source})）` : `图片：${label}`;
            try {
              await replaceAnchor(index, fallback);
            } catch (fallbackError) {
              this.logger.warn('图片锚点回退失败，文档残留占位符', { attemptId: job.attemptId, index, error: fallbackError.message });
            }
          }
        }
      }
      await this.store.complete(job.attemptId, workerId, { warnings });
    } catch (error) {
      const current = await this.store.get(job.attemptId);
      if (current?.status === JOB_STATUS.RUNNING && current.workerId === workerId) {
        await this.store.fail(job.attemptId, workerId, {
          stage: current.document ? FAILURE_STAGE.IMAGES : FAILURE_STAGE.CREATE_DOCUMENT,
          error: error.message || '剪藏处理失败',
        });
      }
      this.logger.error('clip attempt failed', { attemptId: job.attemptId, error });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
