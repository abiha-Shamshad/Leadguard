// Alert delivery sending (Section 12.2/12.3). The worker reloads the delivery row before every side effect.
import type { Pool } from '../client.ts';
import { withOrg } from '../client.ts';
import { emit } from './journal.ts';

export interface SendOutcome {
  kind: 'accepted' | 'rejected' | 'timeout';
  providerMessageId?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface DeliveryToSend {
  id: string;
  orgId: string;
  alertId: string;
  leadId: string;
  alertKind: string;
  channel: 'email' | 'sms';
  recipientEmail: string;
  attempts: number;
}

export const MAX_DELIVERY_ATTEMPTS = 3;

export class RetryableDeliveryError extends Error {}

/**
 * Move a pending delivery to `sending` (attempts incremented before the call). Returns null when the row is
 * missing, not pending (job ran twice), or the lead was handled in the meantime (delivery cancelled).
 */
export async function beginSend(pool: Pool, orgId: string, deliveryId: string): Promise<DeliveryToSend | null> {
  return withOrg(pool, orgId, null, async db => {
    const d = await db.maybe<any>(
      `SELECT d.id, d.org_id, d.alert_id, d.channel, d.state, d.attempts, a.lead_id, a.kind AS alert_kind, l.status AS lead_status, u.email
         FROM lg.alert_deliveries d
         JOIN lg.alerts a ON a.id = d.alert_id
         JOIN lg.leads l ON l.id = a.lead_id
         JOIN lg.users u ON u.id = d.recipient_id
        WHERE d.id = $1
        FOR UPDATE OF d`, [deliveryId]);
    if (!d || d.state !== 'pending' || d.channel === 'in_app') return null;
    if (!['new', 'attempted'].includes(d.lead_status)) {
      await db.q(`UPDATE lg.alert_deliveries SET state = 'cancelled', updated_at = now() WHERE id = $1`, [d.id]);
      await emit(db, orgId, 'alert.delivery_updated', { alert_id: d.alert_id, delivery_id: d.id, state: 'cancelled' });
      return null;
    }
    await db.q(`UPDATE lg.alert_deliveries SET state = 'sending', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [d.id]);
    return { id: d.id, orgId, alertId: d.alert_id, leadId: d.lead_id, alertKind: d.alert_kind, channel: d.channel, recipientEmail: d.email, attempts: d.attempts + 1 };
  });
}

/** Record the provider result. Timeouts become `unknown` and are never resent automatically. */
export async function finishSend(pool: Pool, d: DeliveryToSend, r: SendOutcome): Promise<'accepted' | 'failed' | 'unknown' | 'retry'> {
  return withOrg(pool, d.orgId, null, async db => {
    let state: 'accepted' | 'failed' | 'unknown' | 'pending';
    if (r.kind === 'accepted') state = 'accepted';
    else if (r.kind === 'timeout') state = 'unknown';
    else if (r.retryable && d.attempts < MAX_DELIVERY_ATTEMPTS) state = 'pending';
    else state = 'failed';
    await db.q(
      `UPDATE lg.alert_deliveries SET state = $2, provider_message_id = coalesce($3, provider_message_id), last_error_code = $4, updated_at = now()
        WHERE id = $1 AND state = 'sending'`,
      [d.id, state, r.providerMessageId ?? null, r.kind === 'accepted' ? null : (r.errorCode ?? (r.kind === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR'))]);
    await emit(db, d.orgId, 'alert.delivery_updated', { alert_id: d.alertId, delivery_id: d.id, state });
    return state === 'pending' ? 'retry' : state;
  });
}

/** Sweeper: a delivery stuck in `sending` for over 2 minutes has an unknown outcome (Section 12.3). */
export async function markSendingUnknown(pool: Pool, orgId: string, deliveryId: string): Promise<boolean> {
  return withOrg(pool, orgId, null, async db => {
    const n = await db.exec(
      `UPDATE lg.alert_deliveries SET state = 'unknown', last_error_code = coalesce(last_error_code, 'SEND_OUTCOME_UNKNOWN'), updated_at = now()
        WHERE id = $1 AND state = 'sending' AND updated_at < now() - interval '2 minutes'`, [deliveryId]);
    return n > 0;
  });
}

const RANK: Record<string, number> = { pending: 0, sending: 1, accepted: 2, unknown: 2, delivered: 3, failed: 3, cancelled: 3 };

/** Provider delivery webhook (API-047): monotone - delivered never moves back. */
export async function applyProviderDeliveryEvent(pool: Pool, orgId: string, deliveryId: string, event: 'delivered' | 'bounced' | 'complained' | 'failed'):
  Promise<{ alertId: string; channel: string; state: string } | null> {
  return withOrg(pool, orgId, null, async db => {
    const d = await db.maybe<{ id: string; alert_id: string; channel: string; state: string }>(
      'SELECT id, alert_id, channel, state FROM lg.alert_deliveries WHERE id = $1 FOR UPDATE', [deliveryId]);
    if (!d) return null;
    const target = event === 'delivered' ? 'delivered' : 'failed';
    const allowed = d.state !== 'delivered' && d.state !== 'cancelled' && (RANK[target] >= RANK[d.state]);
    if (allowed && d.state !== target) {
      await db.q('UPDATE lg.alert_deliveries SET state = $2, last_error_code = $3, updated_at = now() WHERE id = $1',
        [d.id, target, target === 'failed' ? `PROVIDER_${event.toUpperCase()}` : null]);
      await emit(db, orgId, 'alert.delivery_updated', { alert_id: d.alert_id, delivery_id: d.id, state: target });
      return { alertId: d.alert_id, channel: d.channel, state: target };
    }
    return { alertId: d.alert_id, channel: d.channel, state: d.state };
  });
}
