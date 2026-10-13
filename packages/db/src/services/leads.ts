// Lead creation and timer scheduling shared by ingest (API-020/021), manual creation (API-024),
// assignment (API-027), reopen (API-029) and member deactivation (API-011).
import type { Db } from '../client.ts';
import { uuidv7 } from '@leadguard/domain';
import { addActivity, audit, emit, userName, type ActorType } from './journal.ts';
import { decideOwner, markAssigned } from './assignment.ts';
import { cancelTimers, computeDue, createTimer, noteDueSet, type TimerKind } from './timers.ts';
import type { OrgSettings } from './settings.ts';

export interface CreateLeadInput {
  leadId?: string;
  sourceId: string | null;
  name: string | null;
  emailNorm: string | null;
  phoneE164: string | null;
  phoneRaw: string | null;
  message: string | null;
  attributes: Record<string, string>;
  isTest: boolean;
  /** undefined = apply the policy's assignment rule; string = explicit owner (manual creation). */
  explicitOwnerId?: string;
  nextAction: string;
  possibleDuplicates?: string[];
  actor: { type: ActorType; id: string | null };
  requestId?: string | null;
  supportGrantId?: string | null;
}

export interface CreatedLead {
  id: string;
  ownerId: string | null;
  dueAt: Date | null;
  assignmentException: string | null;
}

export async function createLead(db: Db, s: OrgSettings, input: CreateLeadInput, now: Date): Promise<CreatedLead> {
  const id = input.leadId ?? uuidv7();
  let ownerId: string | null;
  let rule: string;
  let exception: string | null = null;
  if (input.explicitOwnerId) {
    ownerId = input.explicitOwnerId;
    rule = `by ${(await userName(db, input.actor.id)) ?? 'a team member'} (manual entry)`;
  } else {
    const d = await decideOwner(db, s);
    ownerId = d.ownerId;
    rule = `by ${d.rule}`;
    exception = d.exception;
  }

  await db.q(
    `INSERT INTO lg.leads (id, org_id, source_id, name, email_norm, phone_e164, phone_raw, message, attributes, owner_id,
                           next_action, policy_version, hours_version, is_test, possible_duplicates, cycle_started_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$16)`,
    [id, s.orgId, input.sourceId, input.name, input.emailNorm, input.phoneE164, input.phoneRaw, input.message,
      JSON.stringify(input.attributes), ownerId, input.nextAction, s.policy.version, s.hoursVersion, input.isTest,
      input.possibleDuplicates ?? [], now]);

  let dueAt: Date | null = null;
  if (ownerId) {
    await markAssigned(db, s.orgId, ownerId);
    await addActivity(db, { orgId: s.orgId, leadId: id, type: 'assigned', note: `Assigned to ${(await userName(db, ownerId)) ?? 'team member'} ${rule}`, occurredAt: now });
    dueAt = await scheduleFirstResponse(db, s, id, now);
  } else {
    await addActivity(db, { orgId: s.orgId, leadId: id, type: 'system', subtype: 'unassigned', note: `Left unassigned ${rule}`, occurredAt: now });
    await scheduleUnassigned(db, s, id, now);
  }

  await audit(db, { orgId: s.orgId, actorType: input.actor.type, actorId: input.actor.id, action: 'lead.created', recordType: 'lead', recordId: id, requestId: input.requestId, supportGrantId: input.supportGrantId });
  await emit(db, s.orgId, 'lead.created', { lead_id: id, source_id: input.sourceId, owner_id: ownerId, due_at: dueAt?.toISOString() ?? null });
  return { id, ownerId, dueAt, assignmentException: exception };
}

/** First-response timer for an owned lead; sets leads.due_at. Returns the due instant (null without business hours). */
export async function scheduleFirstResponse(db: Db, s: OrgSettings, leadId: string, base: Date, label = 'First response'): Promise<Date | null> {
  const fr = s.policy.first_response;
  const due = computeDue(base, fr.target_minutes, s, fr.business_hours_only);
  await db.q('UPDATE lg.leads SET due_at = $2, policy_version = $3, hours_version = $4, updated_at = now() WHERE id = $1',
    [leadId, due.dueAt, s.policy.version, s.hoursVersion]);
  if (due.dueAt) {
    await createTimer(db, { orgId: s.orgId, leadId, kind: 'first_response_due', dueAt: due.dueAt, policyVersion: s.policy.version, baseAt: base, businessMinutes: due.businessMinutes, hoursVersion: s.hoursVersion });
  }
  await noteDueSet(db, s, leadId, label, due.dueAt, fr.target_minutes, fr.business_hours_only);
  return due.dueAt;
}

/** Unassigned escalation timer (created + unassigned_escalation_minutes). */
export async function scheduleUnassigned(db: Db, s: OrgSettings, leadId: string, base: Date): Promise<Date | null> {
  const minutes = s.policy.unassigned_escalation_minutes;
  const due = computeDue(base, minutes, s, s.policy.first_response.business_hours_only);
  if (due.dueAt) {
    await createTimer(db, { orgId: s.orgId, leadId, kind: 'unassigned_escalation', dueAt: due.dueAt, policyVersion: s.policy.version, baseAt: base, businessMinutes: due.businessMinutes, hoursVersion: s.hoursVersion });
  }
  return due.dueAt;
}

/** Next follow-up attempt timer (Section 11.4). attemptsMade counts contact attempts in the current cycle. */
export async function scheduleFollowUp(db: Db, s: OrgSettings, leadId: string, base: Date, attemptsMade: number): Promise<{ dueAt: Date | null; exhausted: boolean }> {
  const fu = s.policy.follow_up;
  if (attemptsMade >= fu.max_attempts) {
    await db.q(`UPDATE lg.leads SET due_at = NULL, next_action = 'Decide outcome - follow-up attempts used', updated_at = now() WHERE id = $1`, [leadId]);
    return { dueAt: null, exhausted: true };
  }
  const idx = Math.min(Math.max(attemptsMade - 1, 0), fu.attempt_intervals_minutes.length - 1);
  const minutes = fu.attempt_intervals_minutes[idx];
  const due = computeDue(base, minutes, s, s.policy.first_response.business_hours_only);
  await db.q('UPDATE lg.leads SET due_at = $2, next_action = $3, policy_version = $4, hours_version = $5, updated_at = now() WHERE id = $1',
    [leadId, due.dueAt, `Follow-up attempt ${attemptsMade + 1}`, s.policy.version, s.hoursVersion]);
  if (due.dueAt) {
    await createTimer(db, { orgId: s.orgId, leadId, kind: 'follow_up_due', dueAt: due.dueAt, policyVersion: s.policy.version, baseAt: base, businessMinutes: due.businessMinutes, hoursVersion: s.hoursVersion });
  }
  await noteDueSet(db, s, leadId, `Follow-up attempt ${attemptsMade + 1}`, due.dueAt, minutes, s.policy.first_response.business_hours_only);
  return { dueAt: due.dueAt, exhausted: false };
}

/** Number of contact attempts (call/text/email/visit) since the current cycle started (reopen resets it). */
export async function attemptsInCycle(db: Db, leadId: string): Promise<number> {
  const r = await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM lg.lead_activities a JOIN lg.leads l ON l.id = a.lead_id
      WHERE a.lead_id = $1 AND a.type IN ('call','text','email','visit') AND a.created_at >= coalesce(l.cycle_started_at, l.created_at)`, [leadId]);
  return r.n;
}

/**
 * Re-plan timers after an owner change (API-027, API-011): cancel the old owner's timers and create the
 * next cycle for the new owner. Returns the kinds cancelled and the new due time.
 */
export async function replanForOwner(db: Db, s: OrgSettings, lead: { id: string; status: string }, newOwnerId: string | null, now: Date, why: string): Promise<{ cancelled: TimerKind[]; dueAt: Date | null }> {
  const cancelled = await cancelTimers(db, s.orgId, lead.id, why);
  let dueAt: Date | null = null;
  if (!newOwnerId) {
    if (lead.status === 'new' || lead.status === 'attempted') {
      await db.q('UPDATE lg.leads SET due_at = NULL, updated_at = now() WHERE id = $1', [lead.id]);
      await scheduleUnassigned(db, s, lead.id, now);
    }
    return { cancelled, dueAt: null };
  }
  if (lead.status === 'new') {
    dueAt = await scheduleFirstResponse(db, s, lead.id, now);
  } else if (lead.status === 'attempted') {
    const n = await attemptsInCycle(db, lead.id);
    dueAt = (await scheduleFollowUp(db, s, lead.id, now, Math.max(n, 1))).dueAt;
  }
  return { cancelled, dueAt };
}
