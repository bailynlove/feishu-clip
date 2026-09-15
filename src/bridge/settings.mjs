import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

export function normalizeProxyPort(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw Object.assign(new TypeError('本地代理端口必须是 1–65535 的整数，留空表示关闭'), { code: 'PROXY_PORT_INVALID' });
  }
  return value;
}

export class BridgeSettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { proxyPort: null };
      throw error;
    }
    return { proxyPort: normalizeProxyPort(raw?.proxyPort) };
  }

  saveProxyPort(value) {
    const proxyPort = normalizeProxyPort(value);
    const task = this.writeQueue.then(async () => {
      const settings = { proxyPort };
      const temporary = `${this.filePath}.new`;
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
      return settings;
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }
}
