// Endpoint registry (Section 19) - 52 HTTP operations. The API refuses to start if a route is registered
// without a matching registry entry, or if a registry entry has no route (TASK-004 step 4).

export type Entitlement = 'none' | 'read' | 'bootstrap' | 'setup' | 'business_write' | 'ingest' | 'control' | 'provider';
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

export interface Operation {
  id: string;
  method: Method;
  path: string;
  purpose: string;
  entitlement: Entitlement;
  /** Idempotency-Key header required (Section 18.1, per-operation contracts). */
  idempotency: boolean;
}

const op = (id: string, method: Method, path: string, purpose: string, entitlement: Entitlement, idempotency = false): Operation =>
  ({ id, method, path, purpose, entitlement, idempotency });

export const OPERATIONS: Operation[] = [
  op('API-001', 'GET', '/internal/v1/health', 'Service health', 'none'),
  op('API-002', 'GET', '/api/v1/me', 'Current user and memberships', 'read'),
  op('API-003', 'POST', '/api/v1/organizations', 'Create organization', 'bootstrap', true),
  op('API-004', 'GET', '/api/v1/organizations/current', 'Read organization', 'read'),
  op('API-005', 'PATCH', '/api/v1/organizations/current', 'Update organization', 'setup'),
  op('API-006', 'PUT', '/api/v1/organizations/current/business-hours', 'Replace business hours', 'setup'),
  op('API-007', 'GET', '/api/v1/members', 'List members', 'read'),
  op('API-008', 'POST', '/api/v1/invitations', 'Invite member', 'setup', true),
  op('API-009', 'POST', '/api/v1/invitations/accept', 'Accept invitation', 'bootstrap'),
  op('API-010', 'PATCH', '/api/v1/members/:memberId', 'Change member role', 'control'),
  op('API-011', 'POST', '/api/v1/members/:memberId/deactivate', 'Deactivate member', 'control', true),
  op('API-012', 'GET', '/api/v1/sources', 'List sources', 'read'),
  op('API-013', 'POST', '/api/v1/sources', 'Create source', 'setup', true),
  op('API-014', 'GET', '/api/v1/sources/:sourceId', 'Read source and verification state', 'read'),
  op('API-015', 'POST', '/api/v1/sources/:sourceId/test-event', 'Start source verification', 'setup', true),
  op('API-016', 'GET', '/api/v1/sources/:sourceId/events', 'Source delivery log', 'read'),
  op('API-017', 'POST', '/api/v1/sources/:sourceId/rotate-secret', 'Rotate signing secret', 'setup', true),
  op('API-018', 'POST', '/api/v1/sources/:sourceId/disable', 'Disable source', 'control', true),
  op('API-019', 'POST', '/api/v1/sources/:sourceId/enable', 'Re-enable source', 'setup', true),
  op('API-020', 'POST', '/ingest/v1/forms/:sourceKey', 'Receive website form event', 'ingest'),
  op('API-021', 'POST', '/ingest/v1/calls/:sourceKey', 'Receive call event (provider-neutral)', 'ingest'),
  op('API-022', 'GET', '/api/v1/inbox', 'Needs Action inbox', 'read'),
  op('API-023', 'POST', '/api/v1/leads/search', 'Search and list leads', 'read'),
  op('API-024', 'POST', '/api/v1/leads', 'Create lead manually', 'business_write', true),
  op('API-025', 'GET', '/api/v1/leads/:leadId', 'Read lead', 'read'),
  op('API-026', 'PATCH', '/api/v1/leads/:leadId', 'Update lead contact details', 'business_write'),
  op('API-027', 'POST', '/api/v1/leads/:leadId/assign', 'Assign or claim lead', 'business_write', true),
  op('API-028', 'POST', '/api/v1/leads/:leadId/activities', 'Log contact attempt or note', 'business_write', true),
  op('API-029', 'POST', '/api/v1/leads/:leadId/status', 'Change lead status', 'business_write', true),
  op('API-030', 'POST', '/api/v1/leads/:leadId/snooze', 'Reschedule next action', 'business_write', true),
  op('API-031', 'GET', '/api/v1/leads/:leadId/timeline', 'Lead timeline', 'read'),
  op('API-032', 'POST', '/api/v1/leads/:leadId/merge', 'Merge duplicate lead', 'business_write', true),
  op('API-033', 'GET', '/api/v1/rules/follow-up-policy', 'Read follow-up policy', 'read'),
  op('API-034', 'PUT', '/api/v1/rules/follow-up-policy', 'Replace follow-up policy', 'setup'),
  op('API-035', 'POST', '/api/v1/rules/follow-up-policy/preview', 'Preview due times', 'read'),
  op('API-036', 'GET', '/api/v1/alerts', 'List my alerts', 'read'),
  op('API-037', 'POST', '/api/v1/alerts/:alertId/acknowledge', 'Acknowledge alert', 'control', true),
  op('API-038', 'PUT', '/api/v1/me/notification-preferences', 'Set notification preferences', 'control'),
  op('API-039', 'GET', '/api/v1/dashboard/summary', 'Owner dashboard summary', 'read'),
  op('API-040', 'GET', '/api/v1/dashboard/exceptions', 'Unresolved exceptions', 'read'),
  op('API-041', 'GET', '/api/v1/dashboard/source-health', 'Source health', 'read'),
  op('API-042', 'GET', '/api/v1/billing/plans', 'List plans', 'read'),
  op('API-043', 'GET', '/api/v1/billing/subscription', 'Read subscription', 'read'),
  op('API-044', 'POST', '/api/v1/billing/checkout', 'Start checkout (explicit authorization)', 'control', true),
  op('API-045', 'POST', '/api/v1/billing/cancel', 'Cancel subscription', 'control', true),
  op('API-046', 'POST', '/webhooks/v1/billing/:provider', 'Billing provider webhook', 'provider'),
  op('API-047', 'POST', '/webhooks/v1/notifications/:provider', 'Notification delivery webhook', 'provider'),
  op('API-048', 'POST', '/api/v1/exports', 'Request data export', 'control', true),
  op('API-049', 'GET', '/api/v1/exports/:exportId', 'Export status and download', 'control'),
  op('API-050', 'GET', '/api/v1/support-access/grants', 'List support access grants', 'read'),
  op('API-051', 'POST', '/api/v1/support-access/grants', 'Grant support access', 'control', true),
  op('API-052', 'POST', '/api/v1/support-access/grants/:grantId/revoke', 'Revoke support access', 'control', true),
];

export const OPERATIONS_BY_ID: Record<string, Operation> = Object.fromEntries(OPERATIONS.map(o => [o.id, o]));

export function getOperation(id: string): Operation {
  const o = OPERATIONS_BY_ID[id];
  if (!o) throw new Error(`Unknown operation ${id}`);
  return o;
}
