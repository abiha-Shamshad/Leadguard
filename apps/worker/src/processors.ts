// Job processors: alert deliveries, due-time recompute, source health, billing reconcile, daily metrics.
import { DateTime } from 'luxon';
import {
  beginSend, effectiveState, emit, finishSend, getSubscription, loadOrgSettings, recomputeOrgDueTimes, RetryableDeliveryError, transition, withOrg,
} from '@leadguard/db';
import { businessMinutesBetween, openIntervals } from '@leadguard/domain';
import type { WorkerContext } from './context.ts';
import { log } from './log.ts';

const SUBJECT: Record<string, string> = {
  reminder: 'LeadGuard: a lead needs your action',
  escalation: 'LeadGuard escalation: a lead is overdue',
  unassigned: 'LeadGuard: a new lead has no owner',
};

/**
 * alert-deliveries: reload the row, move it to `sending` (attempts++), call the provider, record the result.
 * Retryable errors re-queue (max 3, exponential 30 s base); timeouts become `unknown` and are never resent.
 * Message content carries a link only - no contact data leaves the app (Section 5, 32).
 */
export async function processDelivery(ctx: WorkerContext, orgId: string, deliveryId: string): Promise<string> {
  const d = await beginSend(ctx.app, orgId, deliveryId);
  if (!d) return 'skipped';
  if (d.channel !== 'email' || !ctx.email.configured) {
    return finishSend(ctx.app, d, { kind: 'rejected', errorCode: 'CHANNEL_NOT_CONFIGURED', retryable: false });
  }
  const link = `${ctx.config.appUrl.replace(/\/$/, '')}/leads/${d.leadId}`;
  let result;
  try {
    result = await ctx.email.send({
      to: d.recipientEmail,
      subject: SUBJECT[d.alertKind] ?? 'LeadGuard alert',
      text: `A lead in LeadGuard needs attention.\n\nOpen it here: ${link}\n\nYou receive this because of your organization's follow-up rules.`,
      idempotencyKey: d.id,
    });
  } catch {
    result = { kind: 'timeout' as const };
  }
  const outcome = await finishSend(ctx.app, d, result.kind === 'accepted'
    ? { kind: 'accepted', providerMessageId: result.providerMessageId }
    : result.kind === 'timeout' ? { kind: 'timeout' } : { kind: 'rejected', errorCode: result.errorCode, retryable: result.retryable });
  log.info('alert delivery', { delivery_id: d.id, org_id: orgId, channel: d.channel, state: outcome, attempts: d.attempts });
  if (outcome === 'retry') throw new RetryableDeliveryError(`retryable provider error for ${d.id}`);
  return outcome;
}

export async function processRecompute(ctx: WorkerContext, orgId: string): Promise<void> {
  const r = await recomputeOrgDueTimes(ctx.app, orgId);
  log.info('due times recomputed', { org_id: orgId, timers: r.timers, leads: r.leads });
}

/** source-health: a verified source silent for longer than its window (default 72 business hours) is failing. */
export async function processSourceHealth(ctx: WorkerContext, orgId: string, sourceId: string): Promise<void> {
  await withOrg(ctx.app, orgId, null, async db => {
    const src = await db.maybe<{ id: string; status: string; last_event_at: Date | null; verified_at: Date | null; silence_window_minutes: number }>(
      'SELECT id, status, last_event_at, verified_at, silence_window_minutes FROM lg.sources WHERE id = $1 FOR UPDATE', [sourceId]);
    if (!src || src.status !== 'verified') return;
    const since = src.last_event_at ?? src.verified_at;
    if (!since) return;
    const s = await loadOrgSettings(db, orgId);
    const now = (await db.one<{ now: Date }>('SELECT now() AS now')).now;
    const silent = businessMinutesBetween(since.toISOString(), now.toISOString(), s.hours);
    if (silent > src.silence_window_minutes) {
      await db.q(`UPDATE lg.sources SET status = 'failing', version = version + 1 WHERE id = $1`, [src.id]);
      await emit(db, orgId, 'source.failing', { source_id: src.id, reason: 'silence' });
      log.warn('source silent', { org_id: orgId, source_id: src.id, silent_business_minutes: Math.round(silent) });
    }
  });
}

/** billing-reconcile (hourly): persist grace expiry, trial end and period-end cancellations. */
export async function processBillingReconcile(ctx: WorkerContext, orgId: string): Promise<void> {
  await withOrg(ctx.app, orgId, null, async db => {
    const now = (await db.one<{ now: Date }>('SELECT now() AS now')).now;
    const sub = await getSubscription(db, orgId, true);
    const eff = effectiveState(sub, now);
    if (eff !== sub.state) {
      await transition(db, orgId, eff, {}, { type: 'system', id: 'billing-reconcile' });
      log.info('subscription state reconciled', { org_id: orgId, from_state: sub.state, to_state: eff });
    }
  });
}

/** Daily snapshot at each org's closing time (pilot metric "overdue at close of business", Section 37). */
export async function processDailyMetrics(ctx: WorkerContext, orgId: string): Promise<void> {
  await withOrg(ctx.app, orgId, null, async db => {
    const s = await loadOrgSettings(db, orgId);
    const now = (await db.one<{ now: Date }>('SELECT now() AS now')).now;
    const local = DateTime.fromJSDate(now).setZone(s.timeZone);
    const intervals = openIntervals(local.startOf('day'), s.hours);
    if (!intervals.length) return;
    const closing = intervals[intervals.length - 1].end!;
    if (local < closing) return;
    const localDate = local.toISODate();
    const exists = await db.maybe('SELECT 1 FROM lg.daily_metrics WHERE org_id = $1 AND local_date = $2', [orgId, localDate]);
    if (exists) return;
    const c = await db.one<{ overdue: number; unassigned: number }>(
      `SELECT count(*) FILTER (WHERE owner_id IS NOT NULL AND due_at < $1)::int AS overdue,
              count(*) FILTER (WHERE owner_id IS NULL)::int AS unassigned
         FROM lg.leads WHERE status IN ('new','attempted') AND NOT is_test`, [closing.toUTC().toJSDate()]);
    await db.q('INSERT INTO lg.daily_metrics (org_id, local_date, overdue_open, unassigned_open) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [orgId, localDate, c.overdue, c.unassigned]);
  });
}
