// Plan usage against configured limits (API-004, API-008, API-013, API-024, API-043). Limits are never estimated.
import type { Db } from '@leadguard/db';
import { findPlan, AppError, type PlanConfig } from '@leadguard/contracts';
import { DateTime } from 'luxon';

export interface Usage {
  members: number;
  /** Active members plus pending invitations - what counts against the member limit when inviting. */
  membersAndInvites: number;
  sources: number;
  leads_this_month: number;
}

export async function usage(db: Db, timeZone: string, now: Date): Promise<Usage> {
  const monthStart = DateTime.fromJSDate(now).setZone(timeZone).startOf('month').toUTC().toJSDate();
  const r = await db.one<{ members: number; invites: number; sources: number; leads: number }>(
    `SELECT (SELECT count(*)::int FROM lg.memberships WHERE status = 'active') AS members,
            (SELECT count(*)::int FROM lg.invitations WHERE status = 'pending' AND expires_at > now()) AS invites,
            (SELECT count(*)::int FROM lg.sources WHERE status <> 'disabled') AS sources,
            (SELECT count(*)::int FROM lg.leads WHERE created_at >= $1 AND NOT is_test) AS leads`, [monthStart]);
  return { members: r.members, membersAndInvites: r.members + r.invites, sources: r.sources, leads_this_month: r.leads };
}

export function limitsView(plans: PlanConfig, planId: string, u: Usage) {
  const p = findPlan(plans, planId);
  return {
    members: { used: u.members, max: p.limits.members },
    sources: { used: u.sources, max: p.limits.sources },
    leads_this_month: { used: u.leads_this_month, max: p.limits.leads_per_month },
  };
}

export function planLimitError(limit: 'members' | 'sources' | 'leads_per_month', used: number, max: number): AppError {
  const msg = {
    members: `Your plan allows ${max} team members. Remove a member or change plan.`,
    sources: `Your plan allows ${max} sources. Disable a source or change plan.`,
    leads_per_month: `Your plan allows ${max} leads per month. Change plan to add more this month.`,
  }[limit];
  return new AppError('PLAN_LIMIT_REACHED', msg, { limit, used, max });
}
