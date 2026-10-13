// Timer firing and alert decisions (Section 12). Runs as lg_app with org context taken from the claimed timer row.
import type { Db, Pool } from '../client.ts';
import { withOrg } from '../client.ts';
import { uuidv7 } from '@leadguard/domain';
import { emit } from './journal.ts';
import { computeDue, createTimer, type TimerKind } from './timers.ts';
import { loadOrgSettings } from './settings.ts';

export interface ClaimedTimer {
  id: string;
  org_id: string;
  claimed_until: Date | null;
}

export interface FireDeps {
  /** True only when a real email adapter is configured (INT-003). Never pretend email was sent. */
  emailConfigured: boolean;
  smsConfigured?: boolean;
}

export type FireOutcome = 'fired' | 'cancelled' | 'skipped' | 'duplicate';

export interface NotificationPrefs {
  in_app: boolean;
  email: boolean;
  sms: boolean;
  escalations_always_email: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = { in_app: true, email: true, sms: false, escalations_always_email: true };

const ALERT_KIND: Record<TimerKind, 'reminder' | 'escalation' | 'unassigned'> = {
  first_response_due: 'reminder',
  follow_up_due: 'reminder',
  escalation: 'escalation',
  unassigned_escalation: 'unassigned',
};

/** Escalation recipients (Section 11.2): notify managers -> owners when no active manager. */
export async function escalationRecipients(db: Db, orgId: string, notify: ('managers' | 'owners')[]): Promise<{ ids: string[]; fellBackToOwners: boolean }> {
  const members = await db.q<{ user_id: string; role: string }>(
    `SELECT user_id, role FROM lg.memberships WHERE org_id = $1 AND status = 'active' AND role IN ('owner','manager') ORDER BY user_id`, [orgId]);
  const managers = members.filter(m => m.role === 'manager').map(m => m.user_id);
  const owners = members.filter(m => m.role === 'owner').map(m => m.user_id);
  const ids = new Set<string>();
  let fell = false;
  if (notify.includes('managers')) {
    if (managers.length) managers.forEach(i => ids.add(i)); else { owners.forEach(i => ids.add(i)); fell = true; }
  }
  if (notify.includes('owners')) owners.forEach(i => ids.add(i));
  return { ids: [...ids], fellBackToOwners: fell };
}

async function prefsFor(db: Db, orgId: string, userId: string): Promise<NotificationPrefs> {
  const r = await db.maybe<{ prefs: Partial<NotificationPrefs> }>('SELECT prefs FROM lg.notification_preferences WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  return { ...DEFAULT_PREFS, ...(r?.prefs ?? {}) };
}

/** Channels for one recipient (Section 11.2: escalations always include in-app; email only if a provider exists). */
export function channelsFor(kind: 'reminder' | 'escalation' | 'unassigned', p: NotificationPrefs, deps: FireDeps): ('in_app' | 'email' | 'sms')[] {
  const out: ('in_app' | 'email' | 'sms')[] = [];
  const isEscalation = kind !== 'reminder';
  if (p.in_app || isEscalation) out.push('in_app');
  if (deps.emailConfigured && (p.email || (isEscalation && p.escalations_always_email))) out.push('email');
  if (deps.smsConfigured && p.sms) out.push('sms');
  return out;
}

/**
 * Process one claimed timer: recheck the lead, create at most one alert for the timer occurrence (DB-11),
 * one delivery per recipient and channel, the follow-on timer, and mark the timer fired - all in one transaction.
 */
export async function fireTimer(pool: Pool, claimed: ClaimedTimer, deps: FireDeps): Promise<FireOutcome> {
  return withOrg(pool, claimed.org_id, null, async db => {
    const t = await db.maybe<{ id: string; lead_id: string; kind: TimerKind; cycle: number; due_at: Date; policy_version: number; state: string; claimed_until: Date | null }>(
      'SELECT id, lead_id, kind, cycle, due_at, policy_version, state, claimed_until FROM lg.lead_timers WHERE id = $1 FOR UPDATE', [claimed.id]);
    if (!t || t.state !== 'claimed') return 'skipped';
    if (claimed.claimed_until && t.claimed_until && t.claimed_until.getTime() !== claimed.claimed_until.getTime()) return 'skipped';

    const lead = await db.one<{ id: string; status: string; owner_id: string | null; is_test: boolean }>(
      'SELECT id, status, owner_id, is_test FROM lg.leads WHERE id = $1 FOR UPDATE', [t.lead_id]);

    const cancel = async (reason: string) => {
      await db.q(`UPDATE lg.lead_timers SET state = 'cancelled', cancel_reason = $2, claimed_until = NULL WHERE id = $1`, [t.id, reason]);
      return 'cancelled' as const;
    };
    if (!['new', 'attempted'].includes(lead.status)) return cancel('lead handled');
    if (t.kind === 'unassigned_escalation' && lead.owner_id) return cancel('lead assigned');
    if (t.kind !== 'unassigned_escalation' && !lead.owner_id) return cancel('lead has no owner');

    const s = await loadOrgSettings(db, claimed.org_id);
    const kind = ALERT_KIND[t.kind];

    let recipients: string[];
    if (kind === 'reminder') {
      const m = await db.maybe<{ status: string }>('SELECT status FROM lg.memberships WHERE org_id = $1 AND user_id = $2', [claimed.org_id, lead.owner_id]);
      recipients = m?.status === 'active' ? [lead.owner_id!] : [];
      if (!recipients.length) return cancel('owner inactive');
    } else {
      recipients = (await escalationRecipients(db, claimed.org_id, s.policy.escalation.notify)).ids;
    }

    const alertId = uuidv7();
    const inserted = await db.maybe<{ id: string }>(
      `INSERT INTO lg.alerts (id, org_id, lead_id, timer_id, kind, policy_version) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (timer_id) DO NOTHING RETURNING id`,
      [alertId, claimed.org_id, lead.id, t.id, kind, t.policy_version]);
    if (!inserted) {
      await db.q(`UPDATE lg.lead_timers SET state = 'fired', claimed_until = NULL WHERE id = $1`, [t.id]);
      return 'duplicate';
    }

    for (const userId of recipients) {
      const prefs = await prefsFor(db, claimed.org_id, userId);
      for (const ch of channelsFor(kind, prefs, deps)) {
        const deliveryId = uuidv7();
        const state = ch === 'in_app' ? 'delivered' : 'pending';
        await db.q(
          `INSERT INTO lg.alert_deliveries (id, org_id, alert_id, recipient_id, channel, state) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (alert_id, recipient_id, channel) DO NOTHING`,
          [deliveryId, claimed.org_id, alertId, userId, ch, state]);
        await emit(db, claimed.org_id, ch === 'in_app' ? 'alert.delivery_updated' : 'alert.requested', { alert_id: alertId, delivery_id: deliveryId, state });
      }
    }

    // Follow-on timer: an overdue reminder schedules the escalation; a repeating escalation schedules the next one.
    const esc = s.policy.escalation;
    if (t.kind === 'first_response_due' || t.kind === 'follow_up_due' || (t.kind === 'escalation' && esc.repeat)) {
      const pending = await db.maybe(`SELECT 1 FROM lg.lead_timers WHERE lead_id = $1 AND kind = 'escalation' AND state IN ('pending','claimed') AND id <> $2`, [lead.id, t.id]);
      if (!pending) {
        const due = computeDue(t.due_at, esc.after_overdue_minutes, s, s.policy.first_response.business_hours_only);
        // Mark this one fired first so the one-pending-per-kind index allows the next escalation cycle.
        await db.q(`UPDATE lg.lead_timers SET state = 'fired', claimed_until = NULL WHERE id = $1`, [t.id]);
        if (due.dueAt) {
          await createTimer(db, { orgId: claimed.org_id, leadId: lead.id, kind: 'escalation', dueAt: due.dueAt, policyVersion: s.policy.version, baseAt: t.due_at, businessMinutes: due.businessMinutes, hoursVersion: s.hoursVersion });
        }
      }
    }
    await db.q(`UPDATE lg.lead_timers SET state = 'fired', claimed_until = NULL WHERE id = $1`, [t.id]);
    return 'fired';
  });
}
