import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDF_CHUNK_BYTES } from './job-store.mjs';

// PDF 分块暂存（#61/#68）：扩展凭据回传的字节按 4 MiB 块落 staging/<attemptId>.part
//（offset = index × PDF_CHUNK_BYTES），已收块位图记在同名 .json sidecar（原子写）。
// 全部到齐后整体验证 size + SHA-256，通过才把文件交给 executor；
// job 终态/整验失败由调用方 discard，cancelled 的 pdf job 由 server 周期 sweep 经
// discardForJob 即时清理（store 层不碰文件系统，cancel 路径自身不带清理），
// 超龄孤儿由 sweep 按 mtime 兜底
export class PdfChunkStaging {
  #dir;
  #now;
  #tails = new Map();

  constructor({ dir, now = () => Date.now() }) {
    if (!dir) throw new TypeError('dir is required');
    this.#dir = dir;
    this.#now = now;
  }

  get dir() {
    return this.#dir;
  }

  #key(attemptId, attachmentId = null) {
    if (!attachmentId) return attemptId;
    const suffix = createHash('sha256').update(String(attachmentId)).digest('hex').slice(0, 24);
    return `${attemptId}.${suffix}`;
  }

  filePath(attemptId, attachmentId = null) {
    return path.join(this.#dir, `${this.#key(attemptId, attachmentId)}.part`);
  }

  #manifestPath(attemptId, attachmentId = null) {
    return path.join(this.#dir, `${this.#key(attemptId, attachmentId)}.json`);
  }

  // 已收块位图（升序去重）；无 sidecar = 一块未收
  async bitmap(attemptId, attachmentId = null) {
    try {
      const manifest = JSON.parse(await readFile(this.#manifestPath(attemptId, attachmentId), 'utf8'));
      return [...new Set(manifest.received)]
        .filter((index) => Number.isInteger(index) && index >= 0)
        .sort((a, b) => a - b);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  // 单进程内串行化同一 attempt 的写块（写文件 + 更新位图是一个临界区）
  #serialize(attemptId, operation) {
    const run = (this.#tails.get(attemptId) ?? Promise.resolve()).then(operation);
    this.#tails.set(attemptId, run.catch(() => {}));
    return run;
  }

  // 写一块到 offset 并更新位图；重发已收块幂等（续传语义），返回最新位图
  putChunk(attemptId, attachmentId, index, buffer) {
    // Legacy signature: putChunk(attemptId, index, buffer)
    if (typeof attachmentId === 'number') [attachmentId, index, buffer] = [null, attachmentId, index];
    const key = this.#key(attemptId, attachmentId);
    return this.#serialize(key, async () => {
      await mkdir(this.#dir, { recursive: true });
      const file = await open(this.filePath(attemptId, attachmentId), 'r+').catch((error) => {
        if (error.code === 'ENOENT') return open(this.filePath(attemptId, attachmentId), 'w');
        throw error;
      });
      try {
        await file.write(buffer, 0, buffer.length, index * PDF_CHUNK_BYTES);
      } finally {
        await file.close();
      }
      const received = await this.bitmap(attemptId, attachmentId);
      if (!received.includes(index)) received.push(index);
      received.sort((a, b) => a - b);
      await this.#writeManifest(attemptId, attachmentId, received);
      return received;
    });
  }

  async #writeManifest(attemptId, attachmentId, received) {
    const manifestPath = this.#manifestPath(attemptId, attachmentId);
    const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ received, updatedAt: this.#now() }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, manifestPath);
  }

  // 整体验证（调用方确保位图已满）：文件字节数 + 流式 SHA-256 对照声明；
  // 任何不匹配抛 PDF_HASH_MISMATCH，文件留给调用方 discard
  async verify(attemptId, attachmentId, declaration) {
    // Legacy signature: verify(attemptId, declaration)
    if (attachmentId && typeof attachmentId === 'object') [attachmentId, declaration] = [null, attachmentId];
    const { sizeBytes, sha256 } = declaration;
    const filePath = this.filePath(attemptId, attachmentId);
    const info = await stat(filePath);
    if (info.size !== sizeBytes) {
      throw Object.assign(new Error(`staging size ${info.size} != declared ${sizeBytes}`), { code: 'PDF_HASH_MISMATCH' });
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    if (hash.digest('hex') !== sha256) {
      throw Object.assign(new Error('staging sha256 mismatch'), { code: 'PDF_HASH_MISMATCH' });
    }
    return filePath;
  }

  // 终态/拒收清理：.part 与位图 sidecar 一并删除
  async discard(attemptId, attachmentId = null) {
    await rm(this.filePath(attemptId, attachmentId), { force: true });
    await rm(this.#manifestPath(attemptId, attachmentId), { force: true });
    this.#tails.delete(this.#key(attemptId, attachmentId));
  }

  // cancel 路径清理（#68）：cancelled 的 pdf job 可能留有未喂齐的 staging；store.cancel
  // 不碰文件系统（纪律见 server.mjs），由 server 周期 sweep 对每个 cancelled pdf job 调这里，
  // 不依赖超龄孤儿 sweep 才清理。非 pdf / 缺 attemptId 的输入安全空转
  async discardForJob(job) {
    if (job?.kind !== 'pdf' || !job?.attemptId) return;
    await this.discard(job.attemptId, job.attachmentId ?? null);
  }

  // 超龄孤儿清理：.part/.json 的最新 mtime 超过 maxAgeMs 即整组删除；返回被清理的 attemptId
  async sweep(maxAgeMs) {
    let entries;
    try {
      entries = await readdir(this.#dir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const cutoff = this.#now() - maxAgeMs;
    const removed = [];
    const attemptIds = new Set(entries.map((entry) => entry.replace(/\.(part|json)$/, '')));
    for (const attemptId of attemptIds) {
      const infos = await Promise.all([
        stat(this.filePath(attemptId)).catch(() => null),
        stat(this.#manifestPath(attemptId)).catch(() => null),
      ]);
      const mtimes = infos.filter(Boolean).map((info) => info.mtimeMs);
      if (mtimes.length && Math.max(...mtimes) <= cutoff) {
        await this.discard(attemptId);
        removed.push(attemptId);
      }
    }
    return removed;
  }
}
