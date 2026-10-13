// Follow-up policy (Section 11.1) as a strict Zod schema. Unknown keys are rejected; no expressions or URLs.
import { z } from 'zod';

const uuid = z.string().uuid();

export const assignmentSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('round_robin'),
    eligible_roles: z.array(z.enum(['member', 'manager', 'owner'])).min(1).max(3).default(['member', 'manager']),
  }),
  z.strictObject({ mode: z.literal('fixed_owner'), owner_id: uuid }),
  z.strictObject({ mode: z.literal('unassigned_queue') }),
]);

export const firstResponseSchema = z.strictObject({
  target_minutes: z.number().int().min(5, '5-1440').max(1440, '5-1440'),
  business_hours_only: z.boolean(),
});

export const followUpSchema = z.strictObject({
  attempt_intervals_minutes: z.array(z.number().int().min(15, '15-10080').max(10080, '15-10080')).min(1).max(6),
  max_attempts: z.number().int().min(1, '1-6').max(6, '1-6'),
});

export const escalationSchema = z.strictObject({
  after_overdue_minutes: z.number().int().min(5, '5-1440').max(1440, '5-1440'),
  notify: z.array(z.enum(['managers', 'owners'])).min(1).max(2),
  repeat: z.boolean(),
});

export const policyBodySchema = z.strictObject({
  assignment: assignmentSchema,
  first_response: firstResponseSchema,
  follow_up: followUpSchema,
  escalation: escalationSchema,
  unassigned_escalation_minutes: z.number().int().min(5, '5-240').max(240, '5-240'),
});

export type PolicyBody = z.infer<typeof policyBodySchema>;
export type FollowUpPolicy = PolicyBody & { version: number };

export function defaultPolicy(): FollowUpPolicy {
  return {
    version: 1,
    assignment: { mode: 'round_robin', eligible_roles: ['member', 'manager'] },
    first_response: { target_minutes: 15, business_hours_only: true },
    follow_up: { attempt_intervals_minutes: [60, 240, 1440], max_attempts: 4 },
    escalation: { after_overdue_minutes: 30, notify: ['managers'], repeat: false },
    unassigned_escalation_minutes: 10,
  };
}

/** Human field messages used in VALIDATION_FAILED for API-034 (e.g. "First response target must be between 5 and 1440 minutes."). */
export const POLICY_FIELD_MESSAGES: Record<string, string> = {
  'first_response.target_minutes': 'First response target must be between 5 and 1440 minutes.',
  'escalation.after_overdue_minutes': 'Escalation delay must be between 5 and 1440 minutes.',
  'follow_up.max_attempts': 'Follow-up attempts must be between 1 and 6.',
  'follow_up.attempt_intervals_minutes': 'Use 1-6 follow-up intervals of 15-10080 minutes each.',
  unassigned_escalation_minutes: 'Unassigned escalation must be between 5 and 240 minutes.',
};
