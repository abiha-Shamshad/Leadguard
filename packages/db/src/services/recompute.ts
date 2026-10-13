// Recompute pending due times after a business-hours or time-zone change (Section 11.3). Each change is
// written to the lead timeline. Pending timers keep their policy_version.
import type { Pool } from '../client.ts';
import { withOrg } from '../client.ts';
import { addBusinessMinutes, formatLocal } from '@leadguard/domain';
import { addActivity, emit } from './journal.ts';
import { loadOrgSettings } from './settings.ts';
import { TIMER_LABEL, type TimerKind } from './timers.ts';

export async function recomputeOrgDueTimes(pool: Pool, orgId: string): Promise<{ timers: number; leads: number }> {
  return withOrg(pool, orgId, null, async db => {
    const s = await loadOrgSettings(db, orgId);
    const timers = await db.q<{ id: string; lead_id: string; kind: TimerKind; due_at: Date; base_at: Date | null; business_minutes: number | null; hours_version: number | null }>(
      `SELECT id, lead_id, kind, due_at, base_at, business_minutes, hours_version FROM lg.lead_timers
        WHERE state = 'pending' AND base_at IS NOT NULL AND business_minutes IS NOT NULL
        ORDER BY lead_id FOR UPDATE`);
    const leads = new Set<string>();
    let changed = 0;
    for (const t of timers) {
      let due: Date | null;
      try {
        due = new Date(addBusinessMinutes(t.base_at!.toISOString(), t.business_minutes!, s.hours));
      } catch {
        due = null;
      }
      if (!due) continue; // keep the previous instant rather than dropping a reminder; dashboard shows no_business_hours
      if (due.getTime() === t.due_at.getTime() && t.hours_version === s.hoursVersion) continue;
      await db.q('UPDATE lg.lead_timers SET due_at = $2, hours_version = $3 WHERE id = $1', [t.id, due, s.hoursVersion]);
      if (t.kind === 'first_response_due' || t.kind === 'follow_up_due') {
        await db.q('UPDATE lg.leads SET due_at = $2, hours_version = $3, updated_at = now() WHERE id = $1 AND status IN (\'new\',\'attempted\')', [t.lead_id, due, s.hoursVersion]);
      }
      await addActivity(db, {
        orgId, leadId: t.lead_id, type: 'system', subtype: 'due_recomputed',
        note: `${TIMER_LABEL[t.kind]} moved from ${formatLocal(t.due_at, s.timeZone)} to ${formatLocal(due, s.timeZone)} after business hours or time zone changed (business hours v${s.hoursVersion})`,
      });
      await emit(db, orgId, 'timer.scheduled', { timer_id: t.id, lead_id: t.lead_id, due_at: due.toISOString() });
      leads.add(t.lead_id);
      changed++;
    }
    return { timers: changed, leads: leads.size };
  });
}
