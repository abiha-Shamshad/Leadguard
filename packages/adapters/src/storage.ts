// Private object storage for export files (Section 6): files expire after 24 h, signed URLs after 15 min.
// `local` stores files on disk and signs download URLs served by the API's /files route (development and
// single-host deployments). A cloud bucket implementation plugs in behind the same interface.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface ObjectStorage {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, expiresAt: Date): string;
  verifySignature(key: string, expires: string, sig: string): boolean;
}

export function createLocalStorage(opts: { dir: string; publicBaseUrl: string; signingSecret: string }): ObjectStorage {
  const root = resolve(opts.dir);
  const safe = (key: string) => {
    if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error('invalid storage key');
    return join(root, key);
  };
  const sign = (key: string, expires: string) => createHmac('sha256', opts.signingSecret).update(`${key}\n${expires}`).digest('hex');
  return {
    name: 'local',
    async put(key, body) {
      const p = safe(key);
      await mkdir(join(p, '..'), { recursive: true });
      await writeFile(p, body);
    },
    async get(key) {
      try { return await readFile(safe(key)); } catch { return null; }
    },
    async delete(key) { await rm(safe(key), { force: true }); },
    signedUrl(key, expiresAt) {
      const expires = String(Math.floor(expiresAt.getTime() / 1000));
      return `${opts.publicBaseUrl.replace(/\/$/, '')}/files/${key}?expires=${expires}&sig=${sign(key, expires)}`;
    },
    verifySignature(key, expires, sig) {
      if (!/^\d+$/.test(expires) || Number(expires) * 1000 < Date.now()) return false;
      const expected = sign(key, expires);
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    },
  };
}
