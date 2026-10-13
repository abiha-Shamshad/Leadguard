// Request body / query schemas shared by the API (Zod 4). Response shapes follow contracts/api-examples.json.
import { z } from 'zod';
import { dayHoursSchema, holidaysSchema, policyBodySchema, firstResponseSchema } from '@leadguard/domain';

export const uuid = z.string().uuid('Must be a UUID.');
const version = z.number().int().min(1);
const shortText = (max: number) => z.string().trim().min(1).max(max);
const reason = z.string().trim().max(500);

// ---------------------------------------------------------------- org
export const createOrgBody = z.strictObject({
  name: shortText(120),
  time_zone: z.string().min(1),
  country: z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code such as US.').default('US'),
  business_hours: z.array(dayHoursSchema).max(21).optional(),
  holidays: holidaysSchema.optional(),
});

export const updateOrgBody = z.strictObject({
  expected_version: version,
  name: shortText(120).optional(),
  time_zone: z.string().min(1).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
});

export const businessHoursBody = z.strictObject({
  expected_version: version,
  days: z.array(dayHoursSchema).min(1).max(21),
  holidays: holidaysSchema.default([]),
});

// ---------------------------------------------------------------- team
export const listMembersQuery = z.object({
  status: z.enum(['active', 'invited', 'deactivated']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const inviteBody = z.strictObject({
  email: z.string().trim().email('Use a valid email address.').max(254),
  role: z.enum(['owner', 'manager', 'member']),
});
export const acceptInvitationBody = z.strictObject({
  token: z.string().regex(/^lgi_[A-Za-z0-9_-]{20,100}$/, 'Malformed invitation token.'),
});
export const changeRoleBody = z.strictObject({ expected_version: version, role: z.enum(['owner', 'manager', 'member']) });
export const deactivateBody = z.strictObject({ reassign_to: uuid.nullable().optional(), reason: reason.optional() });

// ---------------------------------------------------------------- sources
export const fieldMapping = z.strictObject({
  name: z.string().max(100).optional(),
  email: z.string().max(100).optional(),
  phone: z.string().max(100).optional(),
  message: z.string().max(100).optional(),
  entry_id: z.string().max(100).optional(),
  submitted_at: z.string().max(100).optional(),
});
export const createSourceBody = z.strictObject({
  type: z.enum(['web_form_webhook', 'web_form_embed', 'call_webhook']),
  name: shortText(120),
  auth_mode: z.enum(['hmac_v1', 'secret_header', 'embed']).optional(),
  field_mapping: fieldMapping.optional(),
  allowed_origins: z.array(z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d+)?$/i, 'Use exact https origins.')).max(10).optional(),
  provider_key: z.string().max(60).optional(),
});
export const testEventBody = z.strictObject({ window_minutes: z.number().int().min(5).max(60).default(15) });
export const emptyBody = z.strictObject({});
export const disableSourceBody = z.strictObject({ reason: reason.optional() });
export const sourceEventsQuery = z.object({
  outcome: z.enum(['accepted', 'duplicate', 'rejected', 'failed']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------- leads
export const inboxQuery = z.object({
  view: z.enum(['mine', 'team']).optional(),
  section: z.enum(['overdue', 'due_soon', 'unassigned']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const leadStatus = z.enum(['new', 'attempted', 'contacted', 'qualified', 'won', 'lost', 'spam', 'merged']);
export const searchBody = z.strictObject({
  query: z.string().trim().min(2, 'Minimum 2 characters.').max(100).nullable().optional(),
  status: z.array(leadStatus).max(8).nullable().optional(),
  owner_id: z.union([uuid, z.literal('me'), z.literal('unassigned')]).nullable().optional(),
  source_id: uuid.nullable().optional(),
  created_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  created_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  include_test: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().nullable().optional(),
});
export const createLeadBody = z.strictObject({
  name: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  message: z.string().max(4000).nullable().optional(),
  owner_id: z.union([uuid, z.literal('me')]).nullable().optional(),
  attributes: z.record(z.string().max(60), z.string().max(500)).optional(),
});
export const updateLeadBody = z.strictObject({
  expected_version: version,
  contact: z.strictObject({
    name: z.string().trim().max(200).nullable().optional(),
    email: z.string().trim().max(254).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
  }).optional(),
  message: z.string().max(4000).nullable().optional(),
  next_action: z.string().trim().max(200).nullable().optional(),
});
export const assignBody = z.strictObject({
  expected_version: version,
  owner_id: z.union([uuid, z.literal('me')]),
  note: z.string().max(500).optional(),
});
export const activityBody = z.strictObject({
  expected_version: version.optional(),
  type: z.enum(['call', 'text', 'email', 'visit', 'note']),
  outcome: z.enum(['reached', 'no_answer', 'voicemail', 'wrong_number', 'booked', 'not_interested', 'note']).optional(),
  note: z.string().max(2000).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});
export const statusBody = z.strictObject({ expected_version: version, to_status: leadStatus, reason: reason.optional() });
export const snoozeBody = z.strictObject({
  expected_version: version,
  due_at_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use local time YYYY-MM-DDTHH:MM.'),
  reason: z.string().trim().min(1, 'A reason is required.').max(500),
  next_action: z.string().trim().max(200).optional(),
});
export const timelineQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const mergeBody = z.strictObject({ merge_lead_id: uuid, expected_version: version, merge_expected_version: version });

// ---------------------------------------------------------------- rules and alerts
export const replacePolicyBody = policyBodySchema.extend({ expected_version: version });
export const previewBody = z.strictObject({
  policy: z.strictObject({
    first_response: firstResponseSchema,
    escalation: z.strictObject({ after_overdue_minutes: z.number().int().min(5).max(1440) }).loose().optional(),
  }).loose(),
  arrival_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use local time YYYY-MM-DDTHH:MM.'),
});
export const alertsQuery = z.object({
  state: z.enum(['open', 'acknowledged', 'all']).default('open'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const preferencesBody = z.strictObject({
  channels: z.strictObject({ in_app: z.boolean(), email: z.boolean(), sms: z.boolean().default(false) }),
  escalations_always_email: z.boolean().default(true),
});

// ---------------------------------------------------------------- dashboard
export const summaryQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source_id: uuid.optional(),
});
export const pageQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });

// ---------------------------------------------------------------- billing, exports, support
export const checkoutBody = z.strictObject({
  plan_id: z.string().min(1).max(40),
  confirm_plan_and_price: z.boolean().optional(),
  return_url: z.string().url().max(500).optional(),
});
export const cancelBody = z.strictObject({ reason: reason.optional(), confirm: z.boolean().optional() });
export const exportBody = z.strictObject({
  include: z.array(z.enum(['leads', 'activities', 'alerts'])).min(1).max(3).default(['leads', 'activities', 'alerts']),
  format: z.literal('csv_zip').default('csv_zip'),
});
export const grantBody = z.strictObject({
  scope: z.enum(['read_only', 'read_write']).default('read_only'),
  duration_hours: z.number().int().min(1),
  reason: z.string().trim().min(3).max(500),
  confirm_read_write: z.boolean().optional(),
});

// ---------------------------------------------------------------- ingest (normalized call event test double, API-021)
export const normalizedCallEvent = z.object({
  provider: z.string().max(60).optional(),
  call_id: z.string().min(1).max(150),
  event_type: z.string().min(1).max(50),
  direction: z.enum(['inbound', 'outbound']).default('inbound'),
  from: z.string().min(3).max(40),
  to: z.string().max(40).optional(),
  started_at: z.string().datetime({ offset: true }),
  duration_seconds: z.number().int().min(0).default(0),
  answered: z.boolean().default(false),
  voicemail: z.boolean().default(false),
}).passthrough();
