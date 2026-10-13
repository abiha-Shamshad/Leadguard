// Verification windows and their live step checklist (Section 9.2, API-014/015, guided setup 29.3).
import type { Db } from '@leadguard/db';

export type StepName = 'endpoint_reachable' | 'signature_valid' | 'authentication_valid' | 'fields_mapped' | 'lead_created';
export interface Step { step: StepName; state: 'passed' | 'failed' | 'not_reached'; detail?: string }

export function initialSteps(authMode: string): Step[] {
  return [
    { step: 'endpoint_reachable', state: 'not_reached' },
    { step: authMode === 'hmac_v1' ? 'signature_valid' : 'authentication_valid', state: 'not_reached' },
    { step: 'fields_mapped', state: 'not_reached' },
    { step: 'lead_created', state: 'not_reached' },
  ];
}

const FIX: Record<string, string> = {
  SIGNATURE_INVALID: 'Signature did not match. Check the signing secret in your form tool.',
  SIGNATURE_MISSING: 'The signature headers were missing. Configure your form tool to send X-LeadGuard-Timestamp and X-LeadGuard-Signature.',
  TIMESTAMP_INVALID: 'The timestamp header was not a Unix time in seconds.',
  TIMESTAMP_OUT_OF_WINDOW: 'The timestamp was more than 5 minutes from our clock. Check the sending server clock.',
  SECRET_INVALID: 'The X-LeadGuard-Source-Secret header did not match. Re-copy the secret into your form tool.',
  CONTACT_REQUIRED: 'The test enquiry had no email or phone. Map the email or phone field.',
  PAYLOAD_UNMAPPABLE: 'The payload could not be mapped. Check the field mapping.',
  VALIDATION_FAILED: 'The payload was not valid JSON with the mapped fields.',
  PAYLOAD_TOO_LARGE: 'The request body was larger than 64 KB.',
  ORIGIN_NOT_ALLOWED: 'The form was submitted from a website that is not on the allowed list.',
  CHALLENGE_FAILED: 'The bot check failed.',
};

export function stepDetail(reason: string): string {
  return FIX[reason] ?? `Rejected: ${reason}.`;
}

export interface OpenWindow { id: string; steps: Step[]; expires_at: Date; opened_at: Date }

/** Open, unexpired window for a source (expired windows are closed lazily here and by the sweeper). */
export async function openWindow(db: Db, sourceId: string, lock = false): Promise<OpenWindow | null> {
  await db.q(`UPDATE lg.verification_windows SET result = 'expired' WHERE source_id = $1 AND result = 'open' AND expires_at <= now()`, [sourceId]);
  return db.maybe<OpenWindow>(
    `SELECT id, steps, expires_at, opened_at FROM lg.verification_windows WHERE source_id = $1 AND result = 'open'${lock ? ' FOR UPDATE' : ''}`, [sourceId]);
}

/** Record step outcomes on the open window. A failure marks later steps not_reached. */
export async function recordSteps(db: Db, windowId: string, steps: Step[], updates: Partial<Record<StepName, { state: Step['state']; detail?: string }>>): Promise<Step[]> {
  let failed = false;
  const next = steps.map(s => {
    if (failed) return { step: s.step, state: 'not_reached' as const };
    const u = updates[s.step];
    if (!u) return s;
    if (u.state === 'failed') failed = true;
    return u.detail ? { step: s.step, state: u.state, detail: u.detail } : { step: s.step, state: u.state };
  });
  await db.q('UPDATE lg.verification_windows SET steps = $2 WHERE id = $1', [windowId, JSON.stringify(next)]);
  return next;
}
