// Object-level access to leads (Section 7.2): owners/managers see all leads; members see assigned + unassigned
// and write only assigned ones. Objects outside the caller's view return 404, never 403 (Section 7.3).
import type { Db } from '@leadguard/db';
import { AppError } from '@leadguard/contracts';
import type { Actor } from '../plugins/auth.ts';

export interface LeadRow {
  id: string;
  org_id: string;
  source_id: string | null;
  name: string | null;
  email_norm: string | null;
  phone_e164: string | null;
  phone_raw: string | null;
  message: string | null;
  attributes: Record<string, string>;
  status: 'new' | 'attempted' | 'contacted' | 'qualified' | 'won' | 'lost' | 'spam' | 'merged';
  close_reason: string | null;
  merged_into: string | null;
  owner_id: string | null;
  next_action: string | null;
  due_at: Date | null;
  policy_version: number | null;
  hours_version: number | null;
  first_action_at: Date | null;
  is_test: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  possible_duplicates: string[];
  closed_at: Date | null;
  cycle_started_at: Date | null;
}

export function seesAllLeads(actor: Actor): boolean {
  return actor.role === 'owner' || actor.role === 'manager' || actor.support !== null;
}

export function isManager(actor: Actor): boolean {
  return actor.role === 'owner' || actor.role === 'manager';
}

/** SQL predicate for lead visibility; `$n` is the parameter index that holds the caller's user ID. */
export function visibilitySql(actor: Actor, alias: string, userParam: number): string {
  if (seesAllLeads(actor)) return 'true';
  return `(${alias}.owner_id = $${userParam} OR ${alias}.owner_id IS NULL)`;
}

export async function loadLead(db: Db, actor: Actor, leadId: string, opts: { lock?: boolean } = {}): Promise<LeadRow> {
  const lead = await db.maybe<LeadRow>(`SELECT * FROM lg.leads WHERE id = $1${opts.lock ? ' FOR UPDATE' : ''}`, [leadId]);
  if (!lead) throw new AppError('NOT_FOUND', 'Lead not found.');
  if (!seesAllLeads(actor) && lead.owner_id && lead.owner_id !== actor.userId) throw new AppError('NOT_FOUND', 'Lead not found.');
  return lead;
}

/** leads.write: all for owners/managers (and read_write support); assigned only for members. */
export async function loadLeadForWrite(db: Db, actor: Actor, leadId: string): Promise<LeadRow> {
  if (!actor.permissions.includes('leads.write')) throw new AppError('AUTHORIZATION_DENIED', 'You do not have permission to change leads.');
  const lead = await loadLead(db, actor, leadId, { lock: true });
  if (!seesAllLeads(actor) && lead.owner_id !== actor.userId) {
    throw new AppError('AUTHORIZATION_DENIED', 'Only the lead owner or a manager can change this lead. Claim it first.');
  }
  return lead;
}

export function assertVersion(lead: { version: number }, expected: number | undefined, message = 'This lead was changed by someone else. Reload to see the latest version.'): void {
  if (expected !== undefined && lead.version !== expected) {
    throw new AppError('VERSION_CONFLICT', message, { current_version: lead.version });
  }
}
