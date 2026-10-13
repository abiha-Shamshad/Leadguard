// API-039..041 Owner dashboard: factual counts only - no revenue, ROI or "recovered" estimates.
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { AppError, isoOrNull, isoSeconds, pageQuery, summaryQuery } from '@leadguard/contracts';
import { businessMinutesBetween, formatLocal } from '@leadguard/domain';
import { effectiveState, getSubscription, loadOrgSettings, type Db, type OrgSettings } from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  // Same definition as PostgreSQL percentile_cont (linear interpolation).
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

interface Exception { type: string; text: string; since: string; action: string; lead_id?: string; alert_id?: string; source_id?: string; export_id?: string }

/** All unresolved exceptions, computed live; resolved ones disappear automatically. */
async function computeExceptions(db: Db, s: OrgSettings, now: Date): Promise<Exception[]> {
  const out: Exception[] = [];
  const failedDeliveries = await db.q<any>(
    `SELECT d.alert_id, d.channel, d.state, d.updated_at, a.lead_id, a.kind, coalesce(u.name, u.email) AS recipient
       FROM lg.alert_deliveries d JOIN lg.alerts a ON a.id = d.alert_id JOIN lg.leads l ON l.id = a.lead_id JOIN lg.users u ON u.id = d.recipient_id
      WHERE d.state IN ('failed','unknown') AND l.status IN ('new','attempted')
      ORDER BY d.updated_at DESC LIMIT 100`);
  for (const d of failedDeliveries) {
    const what = d.kind === 'escalation' ? 'Escalation' : d.kind === 'unassigned' ? 'Unassigned alert' : 'Reminder';
    const state = d.state === 'unknown' ? 'outcome unknown (provider timed out; not resent)' : 'failed';
    out.push({
      type: d.kind === 'reminder' ? 'reminder_not_delivered' : 'escalation_not_delivered',
      lead_id: d.lead_id, alert_id: d.alert_id, text: `${what} ${d.channel} to ${d.recipient} ${state}`,
      since: isoSeconds(d.updated_at), action: d.state === 'unknown' ? 'Check with the recipient and follow up on the lead' : `Check ${d.recipient}'s ${d.channel} address`,
    });
  }
  const undeliverable = await db.q<any>(
    `SELECT a.id, a.lead_id, a.created_at FROM lg.alerts a JOIN lg.leads l ON l.id = a.lead_id
      WHERE a.kind <> 'reminder' AND l.status IN ('new','attempted') AND NOT EXISTS (SELECT 1 FROM lg.alert_deliveries d WHERE d.alert_id = a.id)
      ORDER BY a.created_at DESC LIMIT 50`);
  for (const a of undeliverable) {
    out.push({ type: 'escalation_not_delivered', lead_id: a.lead_id, alert_id: a.id, text: 'Escalation had no recipient with a deliverable channel', since: isoSeconds(a.created_at), action: 'Add an active manager or owner and check notification settings' });
  }
  const failing = await db.q<any>(
    `SELECT s.id, s.name, s.last_event_at,
            (SELECT count(*)::int FROM lg.delivery_attempts a WHERE a.source_id = s.id AND a.result IN ('rejected','failed') AND a.received_at > now() - interval '24 hours') AS rejected,
            (SELECT a.reason_code FROM lg.delivery_attempts a WHERE a.source_id = s.id AND a.result IN ('rejected','failed') ORDER BY a.received_at DESC LIMIT 1) AS reason,
            (SELECT max(a.received_at) FROM lg.delivery_attempts a WHERE a.source_id = s.id AND a.result IN ('rejected','failed')) AS since
       FROM lg.sources s WHERE s.status = 'failing'`);
  for (const f of failing) {
    const sig = (f.reason ?? '').includes('SIGNATURE') || f.reason === 'SECRET_INVALID';
    out.push({
      type: 'source_failing', source_id: f.id,
      text: f.rejected ? `${f.name}: ${f.rejected} ${sig ? 'signature failures' : 'rejected deliveries'}` : `${f.name}: no events received for longer than its silence window`,
      since: isoSeconds(f.since ?? f.last_event_at ?? now), action: sig ? 'Rotate or re-enter the signing secret' : 'Check the form tool and send a test enquiry',
    });
  }
  const overdue = await db.q<any>(
    `SELECT l.id, l.name, l.due_at, coalesce(u.name, u.email) AS owner FROM lg.leads l LEFT JOIN lg.users u ON u.id = l.owner_id
      WHERE l.status IN ('new','attempted') AND l.owner_id IS NOT NULL AND l.due_at < $1 AND NOT l.is_test ORDER BY l.due_at LIMIT 100`, [now]);
  for (const l of overdue) {
    out.push({ type: 'lead_overdue', lead_id: l.id, text: `${l.name ?? 'Lead'} overdue ${Math.floor((now.getTime() - l.due_at.getTime()) / 60_000)} min (${l.owner})`, since: isoSeconds(l.due_at), action: 'Reassign or call' });
  }
  const unassigned = await db.q<any>(
    `SELECT l.id, l.name, l.created_at FROM lg.leads l WHERE l.status IN ('new','attempted') AND l.owner_id IS NULL AND NOT l.is_test
        AND l.created_at < $1::timestamptz - make_interval(mins => $2) ORDER BY l.created_at LIMIT 100`, [now, s.policy.unassigned_escalation_minutes]);
  for (const l of unassigned) {
    out.push({ type: 'lead_unassigned', lead_id: l.id, text: `${l.name ?? 'Lead'} has no owner (waiting ${Math.floor((now.getTime() - l.created_at.getTime()) / 60_000)} min)`, since: isoSeconds(l.created_at), action: 'Assign an owner' });
  }
  const noHours = await db.q<any>(
    `SELECT l.id, l.name, l.created_at FROM lg.leads l WHERE l.status = 'new' AND l.owner_id IS NOT NULL AND l.due_at IS NULL AND NOT l.is_test LIMIT 50`);
  for (const l of noHours) {
    out.push({ type: 'no_business_hours', lead_id: l.id, text: `${l.name ?? 'Lead'} has no due time - no business hours configured`, since: isoSeconds(l.created_at), action: 'Set business hours' });
  }
  const a = s.policy.assignment;
  if (a.mode === 'fixed_owner') {
    const m = await db.maybe<{ status: string }>('SELECT status FROM lg.memberships WHERE org_id = $1 AND user_id = $2', [s.orgId, a.owner_id]);
    if (m?.status !== 'active') out.push({ type: 'fixed_owner_inactive', text: 'Fixed owner inactive - new leads stay unassigned', since: isoSeconds(now), action: 'Change the assignment rule' });
  }
  const exportsFailed = await db.q<any>(`SELECT id, created_at, failure_reason FROM lg.exports WHERE status = 'failed' AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 5`);
  for (const e of exportsFailed) out.push({ type: 'export_failed', export_id: e.id, text: `Data export failed${e.failure_reason ? ` (${e.failure_reason})` : ''}`, since: isoSeconds(e.created_at), action: 'Request a new export' });
  const sub = await getSubscription(db, s.orgId);
  const st = effectiveState(sub, now);
  if (st === 'past_due') out.push({ type: 'billing_past_due', text: 'Payment failed - update the payment method', since: isoSeconds(sub.past_due_since ?? now), action: 'Update payment method' });
  if (st === 'read_only') out.push({ type: 'subscription_read_only', text: 'Subscription ended - leads are read-only and new events are rejected', since: isoSeconds(sub.trial_ends_at ?? sub.current_period_end ?? now), action: 'Export your data or reactivate' });
  return out;
}

export function registerDashboard(app: FastifyInstance, deps: Deps): void {
  // API-039 Summary for a local date range (max 366 days).
  defineRoute(app, deps, {
    op: 'API-039',
    query: summaryQuery,
    permission: 'dashboard.read',
    permissionMessage: 'Only owners and managers can view the dashboard.',
    handler: async ctx => {
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const today = DateTime.fromJSDate(ctx.now).setZone(s.timeZone).toISODate()!;
      const to = ctx.query.to ?? today;
      const from = ctx.query.from ?? DateTime.fromISO(to).minus({ days: 13 }).toISODate()!;
      const start = DateTime.fromISO(from, { zone: s.timeZone }).startOf('day');
      const end = DateTime.fromISO(to, { zone: s.timeZone }).plus({ days: 1 }).startOf('day');
      if (!start.isValid || !end.isValid || end <= start) throw new AppError('VALIDATION_FAILED', 'Check the date range.', { fields: { from: 'Must be on or before to.' } });
      if (end.diff(start, 'days').days > 366) throw new AppError('VALIDATION_FAILED', 'The date range can be at most 366 days.', { fields: { to: 'Range over 366 days.' } });
      const params = [start.toUTC().toJSDate(), end.toUTC().toJSDate(), ctx.query.source_id ?? null];
      const srcFilter = '($3::uuid IS NULL OR l.source_id = $3)';

      const totals = await ctx.db.one<any>(
        `SELECT count(*) FILTER (WHERE NOT l.is_test AND l.status <> 'merged')::int AS received,
                count(*) FILTER (WHERE l.is_test)::int AS test_excluded,
                count(*) FILTER (WHERE NOT l.is_test AND l.status IN ('contacted','qualified'))::int AS contacted,
                count(*) FILTER (WHERE NOT l.is_test AND l.status = 'won')::int AS won,
                count(*) FILTER (WHERE NOT l.is_test AND l.status = 'lost')::int AS lost,
                count(*) FILTER (WHERE NOT l.is_test AND l.status = 'spam')::int AS spam,
                count(*) FILTER (WHERE NOT l.is_test AND l.status IN ('new','attempted'))::int AS open,
                count(*) FILTER (WHERE NOT l.is_test AND l.status NOT IN ('spam','merged') AND l.first_action_at IS NULL AND l.status IN ('new','attempted'))::int AS no_action_yet
           FROM lg.leads l WHERE l.created_at >= $1 AND l.created_at < $2 AND ${srcFilter}`, params);
      const bySource = await ctx.db.q<{ source: string; count: number }>(
        `SELECT coalesce(src.name, 'Manual entry') AS source, count(*)::int AS count
           FROM lg.leads l LEFT JOIN lg.sources src ON src.id = l.source_id
          WHERE l.created_at >= $1 AND l.created_at < $2 AND ${srcFilter} AND NOT l.is_test AND l.status <> 'merged'
          GROUP BY 1 ORDER BY 2 DESC, 1`, params);
      // Cohort: created in range, excluding is_test, spam and merged. Timestamps only (no lead data loaded).
      const cohort = await ctx.db.q<{ created_at: Date; first_action_at: Date | null; first_due: Date | null }>(
        `SELECT l.created_at, l.first_action_at,
                (SELECT t.due_at FROM lg.lead_timers t WHERE t.lead_id = l.id AND t.kind = 'first_response_due' ORDER BY t.cycle LIMIT 1) AS first_due
           FROM lg.leads l WHERE l.created_at >= $1 AND l.created_at < $2 AND ${srcFilter} AND NOT l.is_test AND l.status NOT IN ('spam','merged')`, params);
      const minutes = cohort.filter(c => c.first_action_at)
        .map(c => businessMinutesBetween(c.created_at.toISOString(), c.first_action_at!.toISOString(), s.hours)).sort((a, b) => a - b);
      const duePassed = cohort.filter(c => c.first_due && c.first_due <= ctx.now);
      const withinTarget = duePassed.filter(c => c.first_action_at && c.first_action_at <= c.first_due!).length;
      const unattended = await ctx.db.one<any>(
        `SELECT (SELECT count(*)::int FROM lg.leads l WHERE l.status IN ('new','attempted') AND l.owner_id IS NOT NULL AND l.due_at < $4 AND NOT l.is_test AND ${srcFilter}) AS overdue_now,
                (SELECT count(*)::int FROM lg.leads l WHERE l.status IN ('new','attempted') AND l.owner_id IS NULL AND NOT l.is_test AND ${srcFilter}) AS unassigned_now,
                (SELECT count(*)::int FROM lg.alerts a JOIN lg.leads l ON l.id = a.lead_id WHERE a.kind = 'escalation' AND a.created_at >= $1 AND a.created_at < $2 AND NOT l.is_test AND ${srcFilter}) AS escalations_sent`,
        [...params, ctx.now]);
      return {
        data: {
          range: { from, to, time_zone: s.timeZone },
          leads: { received: totals.received, test_excluded: totals.test_excluded, by_source: bySource },
          first_action: {
            median_minutes: percentile(minutes, 0.5),
            p90_minutes: percentile(minutes, 0.9),
            within_target_pct: duePassed.length ? Math.round((withinTarget / duePassed.length) * 1000) / 10 : null,
            no_action_yet: totals.no_action_yet,
          },
          unattended,
          outcomes: { contacted: totals.contacted, won: totals.won, lost: totals.lost, spam: totals.spam, open: totals.open },
          definitions: {
            cohort: 'leads created in range, excluding is_test, spam and merged',
            first_action: 'first call/text/email/visit activity (self-reported); notes and status changes excluded',
            within_target_pct: 'cohort leads whose first action was at or before due_at / cohort leads whose due_at has passed',
            time_basis: 'business minutes',
          },
        },
      };
    },
  });

  // API-040 Unresolved exceptions, each with a concrete next action.
  defineRoute(app, deps, {
    op: 'API-040',
    query: pageQuery,
    permission: 'dashboard.read',
    permissionMessage: 'Only owners and managers can view exceptions.',
    handler: async ctx => {
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const all = await computeExceptions(ctx.db, s, ctx.now);
      const offset = Number((deps.cursors.decode(ctx.orgId, 'API-040', ctx.query.cursor) ?? [0])[0]);
      const items = all.slice(offset, offset + ctx.query.limit).map(e => ({
        type: e.type, lead_id: e.lead_id ?? null, alert_id: e.alert_id ?? null, source_id: e.source_id ?? null, export_id: e.export_id ?? null,
        text: e.text, since: e.since, action: e.action,
      }));
      const more = offset + ctx.query.limit < all.length;
      return { data: { items, next_cursor: more ? deps.cursors.encode(ctx.orgId, 'API-040', [offset + ctx.query.limit]) : null } };
    },
  });

  // API-041 Source health for the last 7 days with silence detection (business hours).
  defineRoute(app, deps, {
    op: 'API-041',
    permission: 'dashboard.read',
    permissionMessage: 'Only owners and managers can view source health.',
    handler: async ctx => {
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const rows = await ctx.db.q<any>(
        `SELECT src.id, src.name, src.status, src.last_event_at, src.verified_at, src.silence_window_minutes,
                count(a.id) FILTER (WHERE a.result = 'accepted')::int AS accepted,
                count(a.id) FILTER (WHERE a.result = 'duplicate')::int AS duplicate,
                count(a.id) FILTER (WHERE a.result IN ('rejected','failed'))::int AS rejected
           FROM lg.sources src LEFT JOIN lg.delivery_attempts a ON a.source_id = src.id AND a.received_at > now() - interval '7 days'
          GROUP BY src.id ORDER BY src.created_at, src.id`);
      return {
        data: {
          items: rows.map(r => {
            const since = r.last_event_at ?? r.verified_at;
            const silent = ['verified', 'failing'].includes(r.status) && since
              ? businessMinutesBetween(since.toISOString(), ctx.now.toISOString(), s.hours) > r.silence_window_minutes
              : false;
            return {
              source_id: r.id, name: r.name, status: r.status, last_event_at: isoOrNull(r.last_event_at),
              last_7d: { accepted: r.accepted, duplicate: r.duplicate, rejected: r.rejected }, silence_alert: silent,
            };
          }),
        },
      };
    },
  });
  void formatLocal;
}
