// Response shaping helpers shared by lead endpoints.
import type { Db, OrgSettings } from '@leadguard/db';
import { allowedTargets, firstName, formatLocal, type Role } from '@leadguard/domain';
import { isoOrNull } from '@leadguard/contracts';
import type { Actor } from '../plugins/auth.ts';
import { isManager, seesAllLeads, type LeadRow } from './access.ts';

export function contactPhone(l: Pick<LeadRow, 'phone_e164' | 'phone_raw'>): string | null {
  return l.phone_e164 ?? l.phone_raw ?? null;
}

/** Same predicates as the inbox sections: past due -> overdue; any upcoming due time -> due_soon. */
export function dueState(l: Pick<LeadRow, 'due_at' | 'status' | 'owner_id'>, now: Date): 'overdue' | 'due_soon' | 'none' {
  if (!l.due_at || !['new', 'attempted'].includes(l.status)) return 'none';
  return l.due_at.getTime() < now.getTime() ? 'overdue' : 'due_soon';
}

export function primaryAction(l: LeadRow): { label: string; type: 'call' | 'email' | 'none'; tel?: string; email?: string } {
  const who = firstName(l.name) ?? 'lead';
  if (l.phone_e164 || l.phone_raw) return { label: `Call ${who}`, type: 'call', tel: (l.phone_e164 ?? l.phone_raw)! };
  if (l.email_norm) return { label: `Email ${who}`, type: 'email', email: l.email_norm };
  return { label: 'Review lead', type: 'none' };
}

export function allowedActions(actor: Actor, l: LeadRow): { actions: string[]; statuses: string[] } {
  const canWrite = actor.permissions.includes('leads.write') && (seesAllLeads(actor) || l.owner_id === actor.userId);
  const open = ['new', 'attempted', 'contacted', 'qualified'].includes(l.status);
  const actions: string[] = [];
  const role: Role = isManager(actor) ? (actor.role as Role) : 'member';
  const statuses = canWrite && l.status !== 'merged' ? allowedTargets(l.status, role) : [];
  if (canWrite && l.status !== 'merged') actions.push('log_activity');
  if (l.status !== 'merged' && actor.permissions.includes('leads.assign') && (isManager(actor) || (!l.owner_id && open))) actions.push('assign');
  if (statuses.length) actions.push('change_status');
  if (canWrite && ['new', 'attempted'].includes(l.status)) actions.push('snooze');
  if (canWrite && open && isManager(actor)) actions.push('merge');
  return { actions, statuses };
}

export async function names(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!uniq.length) return new Map();
  const rows = await db.q<{ id: string; name: string | null; email: string }>('SELECT id, name, email FROM lg.users WHERE id = ANY($1::uuid[])', [uniq]);
  return new Map(rows.map(r => [r.id, r.name ?? r.email]));
}

export function ownerObj(id: string | null, nameMap: Map<string, string>): { user_id: string; name: string | null } | null {
  return id ? { user_id: id, name: nameMap.get(id) ?? null } : null;
}

export function dueFields(l: Pick<LeadRow, 'due_at'>, s: Pick<OrgSettings, 'timeZone'>) {
  return { due_at: isoOrNull(l.due_at), due_at_local: formatLocal(l.due_at, s.timeZone) };
}
