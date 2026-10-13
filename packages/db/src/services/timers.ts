// Authoritative timers (Section 11.4). One row per occurrence; one pending timer per lead and kind (DB-12).
// The PostgreSQL row is authoritative; the BullMQ job published from the outbox is only a wake-up.
import type { Db } from '../client.ts';
import { addBusinessMinutes, formatLocal, uuidv7 } from '@leadguard/domain';
import { addActivity, emit } from './journal.ts';
import type { OrgSettings } from './settings.ts';

export type TimerKind = 'first_response_due' | 'follow_up_due' | 'escalation' | 'unassigned_escalation';

export const TIMER_LABEL: Record<TimerKind, string> = {
  first_response_due: 'First-response reminder',
  follow_up_due: 'Follow-up reminder',
  escalation: 'Escalation',
  unassigned_escalation: 'Unassigned escalation',
};

export interface DueComputation {
  dueAt: Date | null;
  businessMinutes: number | null;
  /** True when no open business interval exists in the next 31 days (dashboard exception). */
  noBusinessHours: boolean;
}

/** Due instant from a base time: business minutes when the policy says so, else wall-clock minutes. */
export function computeDue(base: Date, minutes: number, settings: OrgSettings, businessHoursOnly: boolean): DueComputation {
  if (!businessHoursOnly) return { dueAt: new Date(base.getTime() + minutes * 60_000), businessMinutes: null, noBusinessHours: false };
  try {
    return { dueAt: new Date(addBusinessMinutes(base.toISOString(), minutes, settings.hours)), businessMinutes: minutes, noBusinessHours: false };
  } catch (e) {
    if ((e as Error).message === 'NO_BUSINESS_HOURS') return { dueAt: null, businessMinutes: minutes, noBusinessHours: true };
    throw e;
  }
}

export interface CreateTimerInput {
  orgId: string;
  leadId: string;
  kind: TimerKind;
  dueAt: Date;
  policyVersion: number;
  baseAt?: Date | null;
  businessMinutes?: number | null;
  hoursVersion?: number | null;
}

export async function createTimer(db: Db, t: CreateTimerInput): Promise<{ id: string; cycle: number }> {
  const id = uuidv7();
  const row = await db.one<{ cycle: number }>(
    `INSERT INTO lg.lead_timers (id, org_id, lead_id, kind, cycle, due_at, policy_version, base_at, business_minutes, hours_version)
     VALUES ($1, $2, $3, $4,
             (SELECT coalesce(max(cycle), 0) + 1 FROM lg.lead_timers WHERE lead_id = $3 AND kind = $4),
             $5, $6, $7, $8, $9)
     RETURNING cycle`,
    [id, t.orgId, t.leadId, t.kind, t.dueAt, t.policyVersion, t.baseAt ?? null, t.businessMinutes ?? null, t.hoursVersion ?? null]);
  await emit(db, t.orgId, 'timer.scheduled', { timer_id: id, lead_id: t.leadId, due_at: t.dueAt.toISOString() });
  return { id, cycle: row.cycle };
}

const ALL_KINDS: TimerKind[] = ['first_response_due', 'follow_up_due', 'escalation', 'unassigned_escalation'];

/**
 * Cancel pending/claimed timers of the given kinds and write one timeline line per cancelled timer.
 * Returns the kinds cancelled (in a stable order).
 */
export async function cancelTimers(db: Db, orgId: string, leadId: string, why: string, kinds: TimerKind[] = ALL_KINDS, opts: { silent?: boolean } = {}): Promise<TimerKind[]> {
  const rows = await db.q<{ kind: TimerKind }>(
    `UPDATE lg.lead_timers SET state = 'cancelled', cancel_reason = $3, claimed_until = NULL
      WHERE lead_id = $1 AND state IN ('pending','claimed') AND kind = ANY($2::text[])
      RETURNING kind`,
    [leadId, kinds, why]);
  const out = ALL_KINDS.filter(k => rows.some(r => r.kind === k));
  if (!opts.silent) {
    for (const k of out) {
      await addActivity(db, { orgId, leadId, type: 'system', subtype: 'timer_cancelled', note: `${TIMER_LABEL[k]} cancelled - ${why}` });
    }
  }
  return out;
}

/**
 * Cancel deliveries that have not been attempted yet for the lead's open alerts (ALR-04). Deliveries already
 * accepted by a provider cannot be recalled. Returns the number of alerts that had at least one delivery cancelled.
 */
export async function cancelPendingAlerts(db: Db, leadId: string): Promise<number> {
  const cancelled = await db.q<{ alert_id: string }>(
    `UPDATE lg.alert_deliveries d SET state = 'cancelled', updated_at = now()
       FROM lg.alerts a
      WHERE a.id = d.alert_id AND a.lead_id = $1 AND a.state = 'open' AND d.state = 'pending'
      RETURNING d.alert_id`, [leadId]);
  const ids = [...new Set(cancelled.map(r => r.alert_id))];
  if (ids.length) await db.q(`UPDATE lg.alerts SET state = 'cancelled' WHERE id = ANY($1::uuid[])`, [ids]);
  // The lead is handled: any remaining open alerts are closed (their deliveries are final or already in flight).
  await db.q(`UPDATE lg.alerts SET state = 'closed' WHERE lead_id = $1 AND state = 'open'`, [leadId]);
  return ids.length;
}

/** Timeline line for a newly set due time, e.g. "First response due Oct 14, 10:57 AM CDT (15 min target, business hours v2)". */
export async function noteDueSet(db: Db, s: OrgSettings, leadId: string, label: string, dueAt: Date | null, minutes: number, businessMinutes: boolean): Promise<void> {
  const note = dueAt
    ? `${label} due ${formatLocal(dueAt, s.timeZone)} (${minutes} min target${businessMinutes ? `, business hours v${s.hoursVersion}` : ''})`
    : `${label} has no due time - no business hours configured in the next 31 days`;
  await addActivity(db, { orgId: s.orgId, leadId, type: 'system', subtype: 'due_set', note });
}
