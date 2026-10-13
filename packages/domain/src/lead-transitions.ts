// Canonical lead status transition table (Section 30.1).

export type LeadStatus = 'new' | 'attempted' | 'contacted' | 'qualified' | 'won' | 'lost' | 'spam' | 'merged';
export type Role = 'owner' | 'manager' | 'member';

export const OPEN_STATUSES: LeadStatus[] = ['new', 'attempted', 'contacted', 'qualified'];
/** Statuses that need a next action (inbox, timers). */
export const ACTIONABLE_STATUSES: LeadStatus[] = ['new', 'attempted'];
export const CLOSED_STATUSES: LeadStatus[] = ['won', 'lost', 'spam'];

interface TransitionRow {
  from: LeadStatus[];
  to: LeadStatus[];
  /** Only managers and owners may make this transition (reopen); otherwise anyone who may write the lead. */
  managerOnly: boolean;
  reasonRequiredFor: LeadStatus[];
}

export const TRANSITIONS: TransitionRow[] = [
  { from: ['new'], to: ['attempted', 'contacted'], managerOnly: false, reasonRequiredFor: [] },
  { from: ['new'], to: ['lost', 'spam'], managerOnly: false, reasonRequiredFor: ['lost', 'spam'] },
  { from: ['attempted'], to: ['contacted', 'lost', 'spam'], managerOnly: false, reasonRequiredFor: ['lost', 'spam'] },
  { from: ['contacted'], to: ['qualified', 'won', 'lost'], managerOnly: false, reasonRequiredFor: ['lost'] },
  { from: ['qualified'], to: ['won', 'lost'], managerOnly: false, reasonRequiredFor: ['lost'] },
  { from: ['won', 'lost', 'spam'], to: ['attempted'], managerOnly: true, reasonRequiredFor: ['attempted'] },
];

/** Targets reachable through API-029 (merge happens only through API-032). */
export function allowedTargets(from: LeadStatus, role: Role): LeadStatus[] {
  const out: LeadStatus[] = [];
  for (const row of TRANSITIONS) {
    if (!row.from.includes(from)) continue;
    if (row.managerOnly && role === 'member') continue;
    for (const t of row.to) if (!out.includes(t)) out.push(t);
  }
  return out;
}

export type TransitionCheck =
  | { ok: true; reopen: boolean; closing: boolean }
  | { ok: false; code: 'INVALID_TRANSITION'; allowed: LeadStatus[]; reasonMissing?: boolean };

export function checkTransition(from: LeadStatus, to: LeadStatus, role: Role, reason: string | null | undefined): TransitionCheck {
  const allowed = allowedTargets(from, role);
  if (!allowed.includes(to)) return { ok: false, code: 'INVALID_TRANSITION', allowed };
  const row = TRANSITIONS.find(r => r.from.includes(from) && r.to.includes(to))!;
  if (row.reasonRequiredFor.includes(to) && !(reason && reason.trim())) {
    return { ok: false, code: 'INVALID_TRANSITION', allowed, reasonMissing: true };
  }
  return { ok: true, reopen: CLOSED_STATUSES.includes(from), closing: !ACTIONABLE_STATUSES.includes(to) };
}

export function isOpen(status: LeadStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function isActionable(status: LeadStatus): boolean {
  return ACTIONABLE_STATUSES.includes(status);
}
