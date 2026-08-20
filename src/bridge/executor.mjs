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

export function prepareMarkdown(snapshot, attemptId) {
  const images = Array.isArray(snapshot.images) ? snapshot.images.slice(0, IMAGE_LIMITS.maxImages) : [];
  let body = String(snapshot.markdown || '').slice(0, 1_500_000);
  for (const [index, image] of images.entries()) {
    const label = escapeMarkdown(image.label || `图片 ${index + 1}`);
    const source = safeHttpUrl(image.source);
    const trace = source ? `\n\n[原图链接：${label}](${source})` : '';
    body = body.replaceAll(`[[FEISHU_CLIP_IMAGE:${index}]]`, `图片：${label}${trace}`);
  }
  body = body.replace(/\[\[FEISHU_CLIP_IMAGE:\d+\]\]/g, '图片：未能处理');
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
      const prepared = prepareMarkdown(job.snapshot, job.attemptId);
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
        for (let start = 0; start < prepared.images.length; start += 3) {
          const batch = prepared.images.slice(start, start + 3);
          const results = await Promise.allSettled(batch.map(async (image, offset) => {
            if (Date.now() >= deadline) throw new Error('图片阶段超过 90 秒');
            const index = start + offset;
            const fetched = await imageBytes(image);
            totalBytes += fetched.buffer.length;
            if (totalBytes > IMAGE_LIMITS.maxTotalBytes) throw new Error('图片总量超过 40 MiB');
            const filePath = path.join(scratch, `image-${index + 1}.${fetched.metadata.extension}`);
            await writeFile(filePath, fetched.buffer);
            const label = String(image.label || `图片 ${index + 1}`).replace(/[\r\n]+/g, ' ').slice(0, 120);
            await this.lark.run([
              'docs', '+media-insert', '--as', 'user', '--doc', document.documentId,
              '--file', path.basename(filePath), '--type', 'image', '--selection-with-ellipsis', `图片：${label}`,
              '--caption', label, '--format', 'json',
            ], { cwd: scratch, timeoutMs: 30_000 });
          }));
          results.forEach((result, offset) => {
            if (result.status === 'rejected') warnings.push(`图片 ${start + offset + 1}：${result.reason?.message || '处理失败'}`);
          });
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
