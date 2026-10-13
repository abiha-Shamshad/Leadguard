// Assignment decision table (Section 11.2).
import type { Db } from '../client.ts';
import type { OrgSettings } from './settings.ts';

export interface AssignmentDecision {
  ownerId: string | null;
  /** Plain-language reason for the timeline, e.g. "round-robin rule (policy v3)". */
  rule: string;
  /** Set when the decision left the lead unassigned because of a configuration problem. */
  exception: 'fixed_owner_inactive' | 'no_eligible_member' | null;
}

export async function decideOwner(db: Db, s: OrgSettings): Promise<AssignmentDecision> {
  const a = s.policy.assignment;
  const v = s.policy.version;
  if (a.mode === 'round_robin') {
    const row = await db.maybe<{ user_id: string }>(
      `SELECT user_id FROM lg.memberships
        WHERE org_id = $1 AND status = 'active' AND role = ANY($2::text[])
        ORDER BY last_assigned_at ASC NULLS FIRST, user_id ASC
        LIMIT 1`,
      [s.orgId, a.eligible_roles]);
    if (!row) return { ownerId: null, rule: `round-robin rule (policy v${v}) - no eligible active member`, exception: 'no_eligible_member' };
    return { ownerId: row.user_id, rule: `round-robin rule (policy v${v})`, exception: null };
  }
  if (a.mode === 'fixed_owner') {
    const m = await db.maybe<{ status: string }>('SELECT status FROM lg.memberships WHERE org_id = $1 AND user_id = $2', [s.orgId, a.owner_id]);
    if (m?.status === 'active') return { ownerId: a.owner_id, rule: `fixed-owner rule (policy v${v})`, exception: null };
    return { ownerId: null, rule: `fixed-owner rule (policy v${v}) - fixed owner inactive`, exception: 'fixed_owner_inactive' };
  }
  return { ownerId: null, rule: `unassigned-queue rule (policy v${v})`, exception: null };
}

export async function markAssigned(db: Db, orgId: string, userId: string): Promise<void> {
  await db.q('UPDATE lg.memberships SET last_assigned_at = clock_timestamp() WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
}

export async function activeMember(db: Db, orgId: string, userId: string): Promise<{ role: string; status: string } | null> {
  return db.maybe('SELECT role, status FROM lg.memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
}
