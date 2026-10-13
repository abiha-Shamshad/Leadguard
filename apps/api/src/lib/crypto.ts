// Source secrets (AES-256-GCM, newest key first), random tokens and canonical request hashes.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function base62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += BASE62[b % 62];
    }
  }
  return out;
}

/** Public routing key: 24 base62 characters (TASK-007). */
export const newSourceKey = () => `sk_${base62(24)}`;
/** Signing secret: 32 random bytes. */
export const newSigningSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;
/** Invitation token: 32 random bytes; stored only as SHA-256. */
export const newInvitationToken = () => `lgi_${randomBytes(32).toString('base64url')}`;

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Encrypt with the newest key. Layout: iv(12) | tag(16) | ciphertext. */
export function encryptSecret(plain: string, keys: Buffer[]): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keys[0], iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Try every configured key (newest first) so rotation of encryption keys does not break stored secrets. */
export function decryptSecret(blob: Buffer | null, keys: Buffer[]): string | null {
  if (!blob) return null;
  const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), ct = blob.subarray(28);
  for (const k of keys) {
    try {
      const d = createDecipheriv('aes-256-gcm', k, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch { /* next key */ }
  }
  throw new Error('SOURCE_SECRET_UNREADABLE');
}

/** Canonical JSON (keys sorted) for request_hash (Section 16 step 2). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function requestHash(body: unknown): Buffer {
  return sha256(canonicalJson(body));
}
