// Role permissions (Section 7.2).
import type { Role } from './lead-transitions.ts';

export type Permission =
  | 'org.manage' | 'members.manage' | 'sources.manage' | 'leads.read' | 'leads.write' | 'leads.assign'
  | 'rules.manage' | 'dashboard.read' | 'billing.manage' | 'exports.create' | 'support.grant';

export const ALL_PERMISSIONS: Permission[] = [
  'org.manage', 'members.manage', 'sources.manage', 'leads.read', 'leads.write', 'leads.assign',
  'rules.manage', 'dashboard.read', 'billing.manage', 'exports.create', 'support.grant',
];

const MATRIX: Record<Role, Permission[]> = {
  owner: ALL_PERMISSIONS,
  manager: ['members.manage', 'sources.manage', 'leads.read', 'leads.write', 'leads.assign', 'rules.manage', 'dashboard.read'],
  // Members: leads.read/write limited to assigned (+ unassigned for read); leads.assign limited to self-claim.
  member: ['leads.read', 'leads.write', 'leads.assign'],
};

export function permissionsFor(role: Role): Permission[] {
  return MATRIX[role];
}

export function can(role: Role, p: Permission): boolean {
  return MATRIX[role].includes(p);
}

export function isManagerOrOwner(role: Role): boolean {
  return role === 'owner' || role === 'manager';
}
