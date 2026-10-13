// API-036..038 Alerts for the current user, acknowledgement and notification preferences.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, alertsQuery, isoSeconds, preferencesBody, uuid } from '@leadguard/contracts';
import { DEFAULT_PREFS } from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';
import { isManager, visibilitySql } from '../lib/access.ts';

export function registerAlerts(app: FastifyInstance, deps: Deps): void {
  // API-036 List my alerts. Alerts for leads the user can no longer see are hidden.
  defineRoute(app, deps, {
    op: 'API-036',
    query: alertsQuery,
    permission: 'leads.read',
    handler: async ctx => {
      const q = ctx.query;
      const after = deps.cursors.decode(ctx.orgId, `API-036:${q.state}`, q.cursor);
      const stateSql = q.state === 'open' ? 'NOT mine.acknowledged' : q.state === 'acknowledged' ? 'mine.acknowledged' : 'true';
      const vis = visibilitySql(ctx.actor, 'l', 1);
      const rows = await ctx.db.q<any>(
        `WITH mine AS (
           SELECT d.alert_id, bool_and(d.acknowledged_at IS NOT NULL) AS acknowledged,
                  json_agg(json_build_object('channel', d.channel, 'state', d.state) ORDER BY d.channel) AS deliveries
             FROM lg.alert_deliveries d WHERE d.recipient_id = $1 AND d.state <> 'cancelled' GROUP BY d.alert_id)
         SELECT a.id, a.kind, a.lead_id, a.created_at, a.state, l.name AS lead_name, l.due_at, l.status,
                coalesce(u.name, u.email) AS owner_name, mine.acknowledged, mine.deliveries, t.business_minutes, t.kind AS timer_kind
           FROM mine JOIN lg.alerts a ON a.id = mine.alert_id
           JOIN lg.leads l ON l.id = a.lead_id
           JOIN lg.lead_timers t ON t.id = a.timer_id
           LEFT JOIN lg.users u ON u.id = l.owner_id
          WHERE ${vis} AND ${stateSql} AND $1::uuid IS NOT NULL
            AND ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2::timestamptz, $3::uuid))
          ORDER BY a.created_at DESC, a.id DESC LIMIT $4`,
        [ctx.userId, after?.[0] ?? null, after?.[1] ?? null, q.limit + 1]);
      const unread = await ctx.db.one<{ n: number }>(
        `SELECT count(DISTINCT d.alert_id)::int AS n FROM lg.alert_deliveries d JOIN lg.alerts a ON a.id = d.alert_id JOIN lg.leads l ON l.id = a.lead_id
          WHERE d.recipient_id = $1 AND d.acknowledged_at IS NULL AND d.state <> 'cancelled' AND ${vis}`, [ctx.userId]);
      const items = rows.slice(0, q.limit).map(r => {
        const overdue = r.due_at && ['new', 'attempted'].includes(r.status) ? Math.max(0, Math.floor((ctx.now.getTime() - r.due_at.getTime()) / 60_000)) : null;
        const text = r.kind === 'escalation'
          ? `Overdue ${r.business_minutes ?? overdue ?? 0} min - owner ${r.owner_name ?? 'unassigned'}`
          : r.kind === 'unassigned'
            ? 'Unassigned lead waiting for an owner'
            : `${r.timer_kind === 'follow_up_due' ? 'Follow-up' : 'First response'} overdue`;
        return {
          id: r.id, kind: r.kind, lead_id: r.lead_id, lead_name: r.lead_name, text, created_at: isoSeconds(r.created_at),
          my_deliveries: r.deliveries, acknowledged: r.acknowledged,
        };
      });
      const last = rows[q.limit - 1];
      return { data: { items, unread: unread.n, next_cursor: rows.length > q.limit ? deps.cursors.encode(ctx.orgId, `API-036:${q.state}`, [last.created_at.toISOString(), last.id]) : null } };
    },
  });

  // API-037 Acknowledge alert: per recipient, never changes the lead or its timers.
  defineRoute(app, deps, {
    op: 'API-037',
    params: z.object({ alertId: uuid }),
    body: z.strictObject({}),
    handler: async ctx => {
      const mine = await ctx.db.q<{ acknowledged_at: Date | null }>(
        'SELECT acknowledged_at FROM lg.alert_deliveries WHERE alert_id = $1 AND recipient_id = $2 FOR UPDATE', [ctx.params.alertId, ctx.userId]);
      if (!mine.length) throw new AppError('NOT_FOUND', 'Alert not found.');
      const existing = mine.find(m => m.acknowledged_at)?.acknowledged_at;
      const at = existing ?? ctx.now;
      if (mine.some(m => !m.acknowledged_at)) {
        await ctx.db.q('UPDATE lg.alert_deliveries SET acknowledged_at = $3, updated_at = now() WHERE alert_id = $1 AND recipient_id = $2 AND acknowledged_at IS NULL', [ctx.params.alertId, ctx.userId, at]);
        await ctx.audit('alert.acknowledged', 'alert', ctx.params.alertId);
      }
      const lead = await ctx.db.one<{ due_at: Date | null; status: string }>(
        'SELECT l.due_at, l.status FROM lg.alerts a JOIN lg.leads l ON l.id = a.lead_id WHERE a.id = $1', [ctx.params.alertId]);
      const stillOverdue = Boolean(lead.due_at && ['new', 'attempted'].includes(lead.status) && lead.due_at < ctx.now);
      return {
        message: stillOverdue ? 'Alert acknowledged. The lead is still overdue.' : 'Alert acknowledged.',
        data: { id: ctx.params.alertId, acknowledged_by: ctx.userId, acknowledged_at: isoSeconds(at), lead_still_overdue: stillOverdue },
      };
    },
  });

  // API-038 Set notification preferences.
  defineRoute(app, deps, {
    op: 'API-038',
    body: preferencesBody,
    handler: async ctx => {
      if (ctx.actor.support) throw new AppError('AUTHORIZATION_DENIED', 'Support staff do not have notification preferences.');
      const b = ctx.body;
      if (b.channels.sms && !(deps.config.flags.sms_alerts)) {
        throw new AppError('CHANNEL_NOT_AVAILABLE', 'Text-message alerts are not enabled for your organization yet.');
      }
      if (isManager(ctx.actor) && !b.channels.in_app && !b.channels.email && !b.channels.sms) {
        throw new AppError('VALIDATION_FAILED', 'Keep at least one channel on so escalations reach you.', { fields: { channels: 'At least one channel is required for managers.' } });
      }
      const prefs = { ...DEFAULT_PREFS, in_app: b.channels.in_app, email: b.channels.email, sms: b.channels.sms, escalations_always_email: b.escalations_always_email };
      await ctx.db.q(
        `INSERT INTO lg.notification_preferences (org_id, user_id, prefs) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, user_id) DO UPDATE SET prefs = excluded.prefs`, [ctx.orgId, ctx.userId, JSON.stringify(prefs)]);
      await ctx.audit('member.notification_prefs_changed', 'membership', ctx.userId, ['channels']);
      return {
        message: 'Preferences saved.',
        data: {
          channels: { in_app: prefs.in_app, email: prefs.email, sms: prefs.sms },
          escalations_always_email: prefs.escalations_always_email,
          sms_available: deps.config.flags.sms_alerts,
          email_available: deps.email.configured,
        },
      };
    },
  });
}
