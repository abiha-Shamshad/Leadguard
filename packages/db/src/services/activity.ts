// Contact attempts and their effect on status and timers (API-028, answered calls in API-021, Section 11.4/30.1).
import type { Db } from '../client.ts';
import { addActivity, emit } from './journal.ts';
import { attemptsInCycle, scheduleFollowUp } from './leads.ts';
import { cancelPendingAlerts, cancelTimers, type TimerKind } from './timers.ts';
import type { OrgSettings } from './settings.ts';

export type ContactType = 'call' | 'text' | 'email' | 'visit' | 'note';
export type Outcome = 'reached' | 'no_answer' | 'voicemail' | 'wrong_number' | 'booked' | 'not_interested' | 'note';

export interface ActivityEffect {
  activityId: string;
  status: string;
  previousStatus: string;
  firstActionAt: Date | null;
  timersCancelled: TimerKind[];
  timersCreated: TimerKind[];
  alertsCancelled: number;
  nextAction: string | null;
  dueAt: Date | null;
  version: number;
  changed: boolean;
}

interface LeadLike {
  id: string;
  status: string;
  first_action_at: Date | null;
  next_action: string | null;
  due_at: Date | null;
  version: number;
}

export async function applyActivity(db: Db, s: OrgSettings, lead: LeadLike, a: {
  type: ContactType; outcome: Outcome | null; note: string | null; actorId: string | null; occurredAt: Date; evidence: 'self_reported' | 'provider_confirmed';
}): Promise<ActivityEffect> {
  const outcome = a.outcome === 'note' ? null : a.outcome;
  const activityId = await addActivity(db, {
    orgId: s.orgId, leadId: lead.id, type: a.type, outcome, evidence: a.type === 'note' ? 'self_reported' : a.evidence,
    note: a.note, actorId: a.actorId, occurredAt: a.occurredAt,
  });
  const base: ActivityEffect = {
    activityId, status: lead.status, previousStatus: lead.status, firstActionAt: lead.first_action_at, timersCancelled: [], timersCreated: [],
    alertsCancelled: 0, nextAction: lead.next_action, dueAt: lead.due_at, version: lead.version, changed: false,
  };
  await emit(db, s.orgId, 'lead.activity_added', { lead_id: lead.id, activity_id: activityId, outcome: outcome ?? a.type });
  if (a.type === 'note' || !['new', 'attempted', 'contacted', 'qualified'].includes(lead.status)) return base;

  const firstActionAt = lead.first_action_at ?? a.occurredAt;
  const contactMade = outcome === 'reached' || outcome === 'booked';
  let status = lead.status;
  let cancelled: TimerKind[] = [];
  const created: TimerKind[] = [];
  let alertsCancelled = 0;
  let nextAction = lead.next_action;
  let dueAt = lead.due_at;

  if (contactMade) {
    if (status === 'new' || status === 'attempted') status = 'contacted';
    cancelled = await cancelTimers(db, s.orgId, lead.id, 'lead contacted');
    alertsCancelled = await cancelPendingAlerts(db, lead.id);
    nextAction = null;
    dueAt = null;
    await db.q('UPDATE lg.leads SET status = $2, first_action_at = $3, next_action = NULL, due_at = NULL, version = version + 1, updated_at = now() WHERE id = $1',
      [lead.id, status, firstActionAt]);
  } else if (status === 'new' || status === 'attempted') {
    status = 'attempted';
    cancelled = await cancelTimers(db, s.orgId, lead.id, 'contact attempt logged', ['first_response_due', 'follow_up_due', 'escalation']);
    alertsCancelled = await cancelPendingAlerts(db, lead.id);
    await db.q('UPDATE lg.leads SET status = $2, first_action_at = $3, version = version + 1, updated_at = now() WHERE id = $1', [lead.id, status, firstActionAt]);
    const attempts = await attemptsInCycle(db, lead.id);
    const fu = await scheduleFollowUp(db, s, lead.id, a.occurredAt, attempts);
    if (fu.dueAt) created.push('follow_up_due');
    const row = await db.one<{ next_action: string | null; due_at: Date | null }>('SELECT next_action, due_at FROM lg.leads WHERE id = $1', [lead.id]);
    nextAction = row.next_action;
    dueAt = row.due_at;
  } else {
    await db.q('UPDATE lg.leads SET first_action_at = $2, version = version + 1, updated_at = now() WHERE id = $1', [lead.id, firstActionAt]);
  }
  if (status !== lead.status) {
    await emit(db, s.orgId, 'lead.status_changed', { lead_id: lead.id, from: lead.status, to: status });
  }
  const v = await db.one<{ version: number }>('SELECT version FROM lg.leads WHERE id = $1', [lead.id]);
  return { activityId, status, previousStatus: lead.status, firstActionAt, timersCancelled: cancelled, timersCreated: created, alertsCancelled, nextAction, dueAt, version: v.version, changed: true };
}
