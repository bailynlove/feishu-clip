import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const MAX_PAIRING_ATTEMPTS = 5;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function equalText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function writeAtomic(filePath, data) {
  const temporary = `${filePath}.new`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export function createPairingCode(now = Date.now()) {
  const code = randomBytes(18).toString('base64url');
  return { code, pending: { digest: digest(code), expiresAt: now + PAIRING_CODE_TTL_MS, attempts: 0 } };
}

export class PairingStore {
  constructor(filePath, { now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
  }

  async read() {
    return JSON.parse(await readFile(this.filePath, 'utf8'));
  }

  validOrigin(origin) {
    return EXTENSION_ORIGIN.test(origin || '');
  }

  async pair(origin, code) {
    if (!this.validOrigin(origin)) return { ok: false, code: 'ORIGIN_MISMATCH' };
    const state = await this.read();
    const pending = state.pending;
    if (!pending || pending.expiresAt <= this.now()) return { ok: false, code: 'PAIRING_CODE_EXPIRED' };
    if (pending.attempts >= MAX_PAIRING_ATTEMPTS) return { ok: false, code: 'PAIRING_RATE_LIMITED' };
    if (!equalText(pending.digest, digest(code || ''))) {
      pending.attempts += 1;
      await writeAtomic(this.filePath, state);
      return { ok: false, code: pending.attempts >= MAX_PAIRING_ATTEMPTS ? 'PAIRING_RATE_LIMITED' : 'PAIRING_CODE_INVALID' };
    }
    const credential = randomBytes(32).toString('base64url');
    state.active = { origin, credential, pairedAt: this.now() };
    state.pending = null;
    await writeAtomic(this.filePath, state);
    return { ok: true, credential };
  }

  async authorize(origin, credential) {
    if (!this.validOrigin(origin)) return { ok: false, code: 'ORIGIN_MISMATCH' };
    const state = await this.read();
    if (!state.active) return { ok: false, code: 'PAIRING_REQUIRED' };
    if (state.active.origin !== origin) return { ok: false, code: 'ORIGIN_MISMATCH' };
    if (!equalText(state.active.credential, credential || '')) return { ok: false, code: 'PAIRING_REPLACED' };
    return { ok: true };
  }
}
