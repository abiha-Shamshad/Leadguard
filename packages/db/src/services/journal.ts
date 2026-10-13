// Audit, outbox and activity writers. All run inside the caller's transaction (Section 16 step 6).
import type { Db } from '../client.ts';
import { uuidv7 } from '@leadguard/domain';

export type ActorType = 'user' | 'support' | 'system' | 'source' | 'provider';

export interface AuditInput {
  orgId: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  recordType?: string | null;
  recordId?: string | null;
  changedFields?: string[] | null;
  supportGrantId?: string | null;
  requestId?: string | null;
}

/** Audit rows carry actor, action, record and changed field names only - never contact values (Section 32). */
export async function audit(db: Db, a: AuditInput): Promise<void> {
  await db.q(
    `INSERT INTO lg.audit_events (org_id, actor_type, actor_id, action, record_type, record_id, changed_fields, support_grant_id, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [a.orgId, a.actorType, a.actorId, a.action, a.recordType ?? null, a.recordId ?? null, a.changedFields ?? null, a.supportGrantId ?? null, a.requestId ?? null]);
}

/** Outbox payloads carry IDs and states only (Section 31). */
export async function emit(db: Db, orgId: string, routingKey: string, payload: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  await db.q('INSERT INTO lg.outbox_events (id, org_id, routing_key, payload) VALUES ($1,$2,$3,$4)',
    [id, orgId, routingKey, JSON.stringify({ event_id: id, org_id: orgId, ...payload })]);
  return id;
}

export type ActivityType = 'call' | 'text' | 'email' | 'visit' | 'note' | 'event_received' | 'assigned' | 'status_changed' | 'rescheduled' | 'merged' | 'system';

export interface ActivityInput {
  orgId: string;
  leadId: string;
  type: ActivityType;
  subtype?: string | null;
  outcome?: string | null;
  evidence?: 'self_reported' | 'provider_confirmed' | 'system';
  note?: string | null;
  actorId?: string | null;
  occurredAt?: Date | string;
}

/** lead_activities is append-only; corrections are new activities. */
export async function addActivity(db: Db, a: ActivityInput): Promise<string> {
  const id = uuidv7();
  await db.q(
    `INSERT INTO lg.lead_activities (id, org_id, lead_id, type, subtype, outcome, evidence, note, actor_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now()))`,
    [id, a.orgId, a.leadId, a.type, a.subtype ?? null, a.outcome ?? null, a.evidence ?? 'system', a.note ?? null, a.actorId ?? null, a.occurredAt ?? null]);
  return id;
}

export async function userName(db: Db, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const r = await db.maybe<{ name: string | null; email: string }>('SELECT name, email FROM lg.users WHERE id = $1', [userId]);
  return r ? (r.name ?? r.email) : null;
}
