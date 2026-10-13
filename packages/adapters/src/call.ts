// Provider-neutral call adapter (INT-002, BLOCKED by OD-01). Maps a provider webhook to the canonical
// call event used by API-021. Provider field names and signatures come from the selected provider's docs only.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertTestDoubleAllowed } from './common.ts';

export interface CanonicalCall {
  callId: string;
  eventType: string;
  direction: 'inbound' | 'outbound';
  from: string;
  startedAt: string;
  durationSeconds: number;
  answered: boolean;
  voicemail: boolean;
}

export type CallMapResult = { ok: true; call: CanonicalCall } | { ok: false; message: string };

export interface CallAdapter {
  readonly key: string;
  verify(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secrets: string[]): boolean;
  map(body: unknown): CallMapResult;
}

/** Labelled test double using the normalized call event of the API-021 example and an HMAC header. */
export function createTestCallAdapter(): CallAdapter {
  assertTestDoubleAllowed('call');
  return {
    key: 'test_double',
    verify(rawBody, headers, secrets) {
      const sig = String(headers['x-test-signature'] ?? '');
      return secrets.some(s => {
        const expected = createHmac('sha256', s).update(rawBody).digest('hex');
        return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      });
    },
    map(body: any) {
      for (const f of ['call_id', 'event_type', 'from', 'started_at']) {
        if (body?.[f] === undefined || body?.[f] === null || body?.[f] === '') return { ok: false, message: `Required field '${f}' missing after provider mapping.` };
      }
      return {
        ok: true,
        call: {
          callId: String(body.call_id), eventType: String(body.event_type), direction: body.direction === 'outbound' ? 'outbound' : 'inbound',
          from: String(body.from), startedAt: String(body.started_at), durationSeconds: Number(body.duration_seconds ?? 0),
          answered: Boolean(body.answered), voicemail: Boolean(body.voicemail),
        },
      };
    },
  };
}

const registry = new Map<string, CallAdapter>();

export function registerCallAdapter(a: CallAdapter): void {
  registry.set(a.key, a);
}

export function getCallAdapter(key: string | null | undefined): CallAdapter | null {
  return key ? registry.get(key) ?? null : null;
}

export function callAdapterKeys(): string[] {
  return [...registry.keys()];
}
