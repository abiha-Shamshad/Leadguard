// Opaque, signed pagination cursors bound to organization and endpoint (Section 18.3).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@leadguard/contracts';

export interface CursorCodec {
  encode(orgId: string, endpoint: string, key: unknown[]): string;
  decode(orgId: string, endpoint: string, cursor: string | null | undefined): unknown[] | null;
}

export function createCursorCodec(secret: string): CursorCodec {
  const sign = (s: string) => createHmac('sha256', secret).update(s).digest('base64url').slice(0, 22);
  return {
    encode(orgId, endpoint, key) {
      const payload = Buffer.from(JSON.stringify({ o: orgId, e: endpoint, k: key })).toString('base64url');
      return `c_${payload}.${sign(payload)}`;
    },
    decode(orgId, endpoint, cursor) {
      if (!cursor) return null;
      const bad = () => new AppError('VALIDATION_FAILED', 'The page cursor is invalid. Reload the list.', { fields: { cursor: 'Invalid cursor.' } });
      const m = /^c_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
      if (!m) throw bad();
      const expected = sign(m[1]);
      if (expected.length !== m[2].length || !timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))) throw bad();
      const parsed = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      if (parsed.o !== orgId || parsed.e !== endpoint || !Array.isArray(parsed.k)) throw bad();
      return parsed.k;
    },
  };
}

/** Keyset helper: fetch limit+1 rows, return page and the key of the last row when more exist. */
export function page<T>(rows: T[], limit: number, keyOf: (r: T) => unknown[]): { items: T[]; nextKey: unknown[] | null } {
  if (rows.length <= limit) return { items: rows, nextKey: null };
  const items = rows.slice(0, limit);
  return { items, nextKey: keyOf(items[items.length - 1]) };
}
