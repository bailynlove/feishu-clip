import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDF_CHUNK_BYTES } from './job-store.mjs';

// PDF 分块暂存（#61/#68）：扩展凭据回传的字节按 4 MiB 块落 staging/<attemptId>.part
//（offset = index × PDF_CHUNK_BYTES），已收块位图记在同名 .json sidecar（原子写）。
// 全部到齐后整体验证 size + SHA-256，通过才把文件交给 executor；
// job 终态/整验失败由调用方 discard，超龄孤儿由 sweep 按 mtime 清理
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

  filePath(attemptId) {
    return path.join(this.#dir, `${attemptId}.part`);
  }

  #manifestPath(attemptId) {
    return path.join(this.#dir, `${attemptId}.json`);
  }

  // 已收块位图（升序去重）；无 sidecar = 一块未收
  async bitmap(attemptId) {
    try {
      const manifest = JSON.parse(await readFile(this.#manifestPath(attemptId), 'utf8'));
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
  putChunk(attemptId, index, buffer) {
    return this.#serialize(attemptId, async () => {
      await mkdir(this.#dir, { recursive: true });
      const file = await open(this.filePath(attemptId), 'r+').catch((error) => {
        if (error.code === 'ENOENT') return open(this.filePath(attemptId), 'w');
        throw error;
      });
      try {
        await file.write(buffer, 0, buffer.length, index * PDF_CHUNK_BYTES);
      } finally {
        await file.close();
      }
      const received = await this.bitmap(attemptId);
      if (!received.includes(index)) received.push(index);
      received.sort((a, b) => a - b);
      await this.#writeManifest(attemptId, received);
      return received;
    });
  }

  async #writeManifest(attemptId, received) {
    const manifestPath = this.#manifestPath(attemptId);
    const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ received, updatedAt: this.#now() }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, manifestPath);
  }

  // 整体验证（调用方确保位图已满）：文件字节数 + 流式 SHA-256 对照声明；
  // 任何不匹配抛 PDF_HASH_MISMATCH，文件留给调用方 discard
  async verify(attemptId, { sizeBytes, sha256 }) {
    const filePath = this.filePath(attemptId);
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
  async discard(attemptId) {
    await rm(this.filePath(attemptId), { force: true });
    await rm(this.#manifestPath(attemptId), { force: true });
    this.#tails.delete(attemptId);
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
