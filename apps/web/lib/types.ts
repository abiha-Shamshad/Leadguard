// Response shapes from contracts/api-examples.json (only the fields the UI reads).

export type Role = 'owner' | 'manager' | 'member' | 'support';
export type Permission =
  | 'org.manage' | 'members.manage' | 'sources.manage' | 'leads.read' | 'leads.write' | 'leads.assign'
  | 'rules.manage' | 'dashboard.read' | 'billing.manage' | 'exports.create' | 'support.grant';
export type SubState = 'setup_pending' | 'trialing' | 'pilot_invoice' | 'active' | 'past_due' | 'read_only';
export type LeadStatus = 'new' | 'attempted' | 'contacted' | 'qualified' | 'won' | 'lost' | 'spam' | 'merged';

export interface Me {
  user: { id: string; name: string | null; email: string };
  active_org: { id: string; name: string; role: Role; time_zone: string } | null;
  organizations: { id: string; name: string; role: Role }[];
  permissions: Permission[];
  subscription_state: SubState | null;
  setup_complete: boolean;
}

export interface DayHours { weekday: string; open: string | null; close: string | null }

export interface Org {
  id: string; name: string; time_zone: string; country: string; version: number;
  business_hours: { version: number | null; days: DayHours[]; holidays: string[] };
  setup: { org_created: boolean; source_verified: boolean; team_invited: boolean; complete: boolean };
  plan_id: string; subscription_state: SubState;
  limits: Record<'members' | 'sources' | 'leads_this_month', { used: number; max: number }>;
}

export interface InboxItem {
  id: string; name: string | null; phone_masked?: string | null; source: string; owner?: string | null; next_action: string | null;
  due_at_local?: string | null; overdue_minutes?: number; due_in_minutes?: number | null; waiting_minutes?: number;
  escalated?: boolean; version: number; is_test?: boolean;
}
export type InboxSection = 'overdue' | 'due_soon' | 'unassigned';
export interface Inbox {
  view: 'mine' | 'team';
  counts: Record<InboxSection, number>;
  sections: Record<InboxSection, InboxItem[]>;
  cursors: Record<InboxSection, string | null>;
}

export interface Lead {
  id: string; status: LeadStatus;
  contact: { name: string | null; email: string | null; phone: string | null };
  message: string | null;
  source: { id: string | null; name: string; type: string };
  owner: { user_id: string; name: string | null } | null;
  next_action: string | null; due_at: string | null; due_at_local: string | null; due_state: 'overdue' | 'due_soon' | 'none';
  first_action_at: string | null; version: number; created_at: string; is_test?: boolean;
  attributes?: Record<string, string>;
  primary_action?: { label: string; type: 'call' | 'email' | 'none'; tel?: string; email?: string };
  allowed_actions?: string[]; allowed_statuses?: LeadStatus[];
  timers?: { kind: string; due_at: string; state: string }[];
  events?: { event_id: string; kind: string; received_at: string }[];
  merged_into?: string; possible_duplicate_ids?: string[];
}

export interface TimelineItem {
  at: string; type: string; text: string; note?: string; alert_id?: string;
  deliveries?: { recipient: string | null; channel: string; state: string }[];
}

export interface Member {
  user_id?: string; invitation_id?: string; name?: string | null; email: string; role: Role; status: 'active' | 'invited' | 'deactivated';
  open_leads?: number; version?: number; expires_at?: string;
}

export interface SourceSummary {
  id: string; name: string; type: string; status: 'draft' | 'testing' | 'verified' | 'failing' | 'disabled';
  last_event_at: string | null; verified_at?: string;
  events_24h?: { accepted: number; duplicate: number; rejected: number };
  last_error?: { reason: string; at: string; count: number };
}
export interface VerificationStep { step: string; state: 'passed' | 'failed' | 'not_reached'; detail?: string }
export interface SourceDetail extends SourceSummary {
  auth_mode: string; endpoint_url: string;
  verification: { started_at: string; expires_at: string; result: string; steps: VerificationStep[] } | null;
}

export interface Policy {
  version: number;
  assignment: { mode: 'round_robin'; eligible_roles: string[] } | { mode: 'fixed_owner'; owner_id: string } | { mode: 'unassigned_queue' };
  first_response: { target_minutes: number; business_hours_only: boolean };
  follow_up: { attempt_intervals_minutes: number[]; max_attempts: number };
  escalation: { after_overdue_minutes: number; notify: ('managers' | 'owners')[]; repeat: boolean };
  unassigned_escalation_minutes: number;
  updated_by?: string | null; updated_at?: string;
}

export interface AlertItem {
  id: string; kind: 'reminder' | 'escalation' | 'unassigned'; lead_id: string; lead_name: string | null; text: string; created_at: string;
  my_deliveries: { channel: string; state: string }[]; acknowledged: boolean;
}

export interface Page<T> { items: T[]; next_cursor: string | null }
