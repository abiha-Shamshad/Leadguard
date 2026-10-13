// API-033..035 Follow-up policy: read, replace (new version), preview with the production calculator.
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { AppError, isoSeconds, previewBody, replacePolicyBody } from '@leadguard/contracts';
import { addBusinessMinutes, formatLocalWithWeekday, openIntervals, parseLocalWallTime, POLICY_FIELD_MESSAGES, WEEKDAYS } from '@leadguard/domain';
import { emit, loadOrgSettings, type OrgSettings } from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';
import { zodToValidation } from '../lib/validation.ts';
import { localTimeError } from './leads.ts';
import { names } from '../lib/present.ts';

function hoursStatus(s: OrgSettings, arrivalUtc: string): string {
  const local = DateTime.fromISO(arrivalUtc, { zone: 'utc' }).setZone(s.timeZone);
  const today = openIntervals(local.startOf('day'), s.hours);
  const closesAt = today.find(iv => iv.end! > local);
  const parts: string[] = [];
  if (closesAt) parts.push(`closes ${closesAt.end!.toFormat('h:mm a')}`);
  else parts.push('closed now');
  const closedDays = WEEKDAYS.filter(w => !s.hours.days.some(d => d.weekday === w && d.open && d.close));
  const names_: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const shown = closedDays.filter(d => d === 'sat' || closedDays.length <= 2);
  if (shown.length) parts.push(`${shown.map(d => names_[d]).join(' and ')} closed`);
  return parts.join('; ');
}

/** Plain-language explanation of how business minutes were spent across days. */
function explain(s: OrgSettings, arrivalUtc: string, minutes: number, dueUtc: string): string {
  const arrival = DateTime.fromISO(arrivalUtc, { zone: 'utc' }).setZone(s.timeZone);
  const due = DateTime.fromISO(dueUtc, { zone: 'utc' }).setZone(s.timeZone);
  const today = openIntervals(arrival.startOf('day'), s.hours);
  let remainingToday = 0;
  for (const iv of today) {
    const from = arrival > iv.start! ? arrival : iv.start!;
    if (from < iv.end!) remainingToday += iv.end!.diff(from, 'minutes').minutes;
  }
  remainingToday = Math.round(remainingToday);
  if (due.hasSame(arrival, 'day')) return `${minutes} business minutes after arrival, the same day.`;
  if (remainingToday > 0 && remainingToday < minutes) {
    const opening = openIntervals(due.startOf('day'), s.hours)[0]?.start;
    return `${remainingToday} business minutes remain ${arrival.toFormat('cccc')}; the remaining ${minutes - remainingToday} minutes start at ${due.toFormat('cccc')} ${opening?.toFormat('h:mm a') ?? ''} opening.`.replace(' opening.', ' opening.');
  }
  const opening = openIntervals(due.startOf('day'), s.hours)[0]?.start;
  return `Arrives outside business hours; the ${minutes} minutes start at ${due.toFormat('cccc')} ${opening?.toFormat('h:mm a') ?? ''} opening.`;
}

export function registerRules(app: FastifyInstance, deps: Deps): void {
  // API-033 Read follow-up policy (members see it read-only).
  defineRoute(app, deps, {
    op: 'API-033',
    permission: 'leads.read',
    handler: async ctx => {
      const row = await ctx.db.one<{ version: number; policy: any; created_by: string; created_at: Date }>(
        'SELECT version, policy, created_by, created_at FROM lg.follow_up_policies WHERE is_current');
      const nm = await names(ctx.db, [row.created_by]);
      return { data: { version: row.version, ...row.policy, updated_by: nm.get(row.created_by) ?? null, updated_at: isoSeconds(row.created_at) } };
    },
  });

  // API-034 Replace follow-up policy. Pending timers keep their version; new timers use the new one.
  defineRoute(app, deps, {
    op: 'API-034',
    permission: 'rules.manage',
    permissionMessage: 'Only owners and managers can change follow-up rules.',
    handler: async ctx => {
      const parsed = replacePolicyBody.safeParse(ctx.req.body ?? {});
      if (!parsed.success) throw zodToValidation(parsed.error, POLICY_FIELD_MESSAGES);
      const { expected_version, ...policy } = parsed.data;
      const cur = await ctx.db.one<{ version: number }>('SELECT version FROM lg.follow_up_policies WHERE is_current FOR UPDATE');
      if (cur.version !== expected_version) throw new AppError('VERSION_CONFLICT', 'Follow-up rules were changed by someone else. Reload and try again.', { current_version: cur.version });
      if (policy.assignment.mode === 'fixed_owner') {
        const m = await ctx.db.maybe<{ status: string }>('SELECT status FROM lg.memberships WHERE org_id = $1 AND user_id = $2', [ctx.orgId, policy.assignment.owner_id]);
        if (!m || m.status !== 'active') throw new AppError('VALIDATION_FAILED', 'The fixed owner must be an active team member.', { fields: { 'assignment.owner_id': 'Choose an active team member.' } });
      }
      const next = cur.version + 1;
      await ctx.db.q('UPDATE lg.follow_up_policies SET is_current = false WHERE org_id = $1 AND is_current', [ctx.orgId]);
      await ctx.db.q('INSERT INTO lg.follow_up_policies (org_id, version, policy, created_by) VALUES ($1,$2,$3,$4)', [ctx.orgId, next, JSON.stringify(policy), ctx.userId]);
      await ctx.audit('rules.policy_changed', 'follow_up_policy', ctx.orgId, Object.keys(policy));
      await emit(ctx.db, ctx.orgId, 'rules.policy_changed', { version: next });
      return {
        message: `Follow-up rules saved (version ${next}).`,
        data: { version: next, active_from: isoSeconds(ctx.now), applies_to: 'new leads and next timer step of open leads' },
      };
    },
  });

  // API-035 Preview due times with exactly the production calculator.
  defineRoute(app, deps, {
    op: 'API-035',
    body: previewBody,
    permission: 'rules.manage',
    permissionMessage: 'Only owners and managers can preview follow-up rules.',
    handler: async ctx => {
      const b = ctx.body;
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      let arrival: string;
      try { arrival = parseLocalWallTime(b.arrival_local, s.timeZone); } catch (e) { throw localTimeError((e as Error).message, b.arrival_local, s.timeZone, 'arrival_local'); }
      const fr = b.policy.first_response;
      const escMinutes = (b.policy.escalation as any)?.after_overdue_minutes ?? s.policy.escalation.after_overdue_minutes;
      let due: string, esc: string;
      try {
        due = fr.business_hours_only ? addBusinessMinutes(arrival, fr.target_minutes, s.hours) : new Date(Date.parse(arrival) + fr.target_minutes * 60_000).toISOString();
        esc = fr.business_hours_only ? addBusinessMinutes(due, escMinutes, s.hours) : new Date(Date.parse(due) + escMinutes * 60_000).toISOString();
      } catch {
        throw new AppError('VALIDATION_FAILED', 'No business hours are configured in the next 31 days.', { fields: { business_hours: 'Add opening hours first.' } });
      }
      return {
        data: {
          arrival_local: formatLocalWithWeekday(arrival, s.timeZone),
          business_hours_version: s.hoursVersion,
          business_hours_status: hoursStatus(s, arrival),
          first_response_due_local: formatLocalWithWeekday(due, s.timeZone),
          explanation: fr.business_hours_only ? explain(s, arrival, fr.target_minutes, due) : `${fr.target_minutes} minutes after arrival (business hours not applied).`,
          escalation_at_local: formatLocalWithWeekday(esc, s.timeZone),
        },
      };
    },
  });
}
