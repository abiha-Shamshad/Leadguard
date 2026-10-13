// Email / notification adapter (INT-003, BLOCKED by OD-06). Section 12.2 delivery states.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertTestDoubleAllowed } from './common.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Idempotency key passed to the provider when it supports one (delivery row id). */
  idempotencyKey: string;
}

export type SendResult =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'rejected'; errorCode: string; retryable: boolean }
  /** Request may have reached the provider but the response was lost - never resend automatically. */
  | { kind: 'timeout' };

export interface DeliveryEvent {
  providerEventId: string;
  providerMessageId: string;
  event: 'delivered' | 'bounced' | 'complained' | 'failed';
  at: string;
}

export interface EmailAdapter {
  readonly name: string;
  /** False for `none`: callers create in-app deliveries only and never pretend email was sent. */
  readonly configured: boolean;
  send(msg: EmailMessage): Promise<SendResult>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  mapWebhook(body: unknown): DeliveryEvent | null;
}

export const noneEmailAdapter: EmailAdapter = {
  name: 'none',
  configured: false,
  async send() { return { kind: 'rejected', errorCode: 'EMAIL_NOT_CONFIGURED', retryable: false }; },
  verifyWebhook() { return false; },
  mapWebhook() { return null; },
};

/** Labelled test double (automated tests only). Signs webhooks with HMAC-SHA256 hex of the raw body. */
export function createTestEmailAdapter(opts: { webhookSecret: string; behaviour?: (msg: EmailMessage) => SendResult }): EmailAdapter & { sent: EmailMessage[] } {
  assertTestDoubleAllowed('email');
  const sent: EmailMessage[] = [];
  return {
    name: 'test_double',
    configured: true,
    sent,
    async send(msg) {
      sent.push(msg);
      return opts.behaviour ? opts.behaviour(msg) : { kind: 'accepted', providerMessageId: `msg_${msg.idempotencyKey.slice(0, 8)}` };
    },
    verifyWebhook(rawBody, headers) {
      const sig = String(headers['x-test-signature'] ?? '');
      const expected = createHmac('sha256', opts.webhookSecret).update(rawBody).digest('hex');
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    },
    mapWebhook(body: any) {
      if (!body?.message_id || !body?.event) return null;
      const map: Record<string, DeliveryEvent['event']> = { delivered: 'delivered', bounced: 'bounced', complained: 'complained', failed: 'failed' };
      const ev = map[body.event];
      if (!ev) return null;
      return { providerEventId: body.event_id ?? `${body.message_id}:${body.event}`, providerMessageId: body.message_id, event: ev, at: body.at ?? new Date().toISOString() };
    },
  };
}

export function createEmailAdapter(name: string | undefined): EmailAdapter {
  if (!name || name === 'none') return noneEmailAdapter;
  // Real providers are added in TASK-014 from that provider's documentation only.
  throw new Error(`EMAIL_PROVIDER=${name} has no adapter yet (INT-003 BLOCKED). Use EMAIL_PROVIDER=none.`);
}
