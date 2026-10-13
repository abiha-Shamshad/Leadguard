// UUID version 7 (RFC 9562): 48-bit Unix ms timestamp + version + random. All primary keys use it (Section 14.1).
import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  // Keep IDs generated in the same millisecond monotonic using a 12-bit counter in rand_a.
  if (now === lastMs) seq = (seq + 1) & 0xfff; else { lastMs = now; seq = b.readUInt16BE(6) & 0x7ff; }
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
