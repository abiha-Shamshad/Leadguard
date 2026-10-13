// Subscription state and entitlement classes (Section 13). The guard reads `subscriptions` inside the same
// transaction as the write.
import type { Db } from '../client.ts';
import { AppError, type Entitlement } from '@leadguard/contracts';
import { audit, emit } from './journal.ts';

export type SubState = 'setup_pending' | 'trialing' | 'pilot_invoice' | 'active' | 'past_due' | 'read_only';

export interface SubscriptionRow {
  org_id: string;
  state: SubState;
  plan_id: string;
  trial_started_at: Date | null;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  past_due_since: Date | null;
  provider: string | null;
  provider_customer_id: string | null;
  version: number;
}

export const PAST_DUE_GRACE_DAYS = 7;

export async function getSubscription(db: Db, orgId: string, lock = false): Promise<SubscriptionRow> {
  return db.one<SubscriptionRow>(`SELECT * FROM lg.subscriptions WHERE org_id = $1${lock ? ' FOR UPDATE' : ''}`, [orgId]);
}

/**
 * State that applies right now. The billing-reconcile job persists these transitions hourly; the guard applies
 * them immediately so an expired subscription is never writable between job runs.
 */
export function effectiveState(s: SubscriptionRow, now: Date): SubState {
  if (s.state === 'trialing' && s.trial_ends_at && s.trial_ends_at <= now) return 'read_only';
  if (s.state === 'past_due' && s.past_due_since && s.past_due_since.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000 <= now.getTime()) return 'read_only';
  if (s.cancel_at_period_end && ['active', 'past_due', 'pilot_invoice'].includes(s.state) && s.current_period_end && s.current_period_end <= now) return 'read_only';
  return s.state;
}

const INACTIVE_MESSAGE: Record<string, string> = {
  setup: 'Reactivate your subscription before changing settings.',
  business_write: 'Your subscription has ended. Leads are read-only; export your data or reactivate.',
  setup_pending: 'Finish setup by verifying a source to start your trial.',
};

/** Throws 423 SUBSCRIPTION_INACTIVE when the class is not allowed in the current state (Section 13.2). */
export function checkEntitlement(cls: Entitlement, state: SubState): void {
  if (cls === 'read' || cls === 'bootstrap' || cls === 'control' || cls === 'none' || cls === 'provider') return;
  if (cls === 'setup') {
    if (state === 'read_only') throw new AppError('SUBSCRIPTION_INACTIVE', INACTIVE_MESSAGE.setup, { state });
    return;
  }
  if (cls === 'business_write') {
    if (state === 'read_only') throw new AppError('SUBSCRIPTION_INACTIVE', INACTIVE_MESSAGE.business_write, { state });
    if (state === 'setup_pending') throw new AppError('SUBSCRIPTION_INACTIVE', INACTIVE_MESSAGE.setup_pending, { state });
    return;
  }
  if (cls === 'ingest') {
    // setup_pending ingest is decided by the ingest pipeline (only into an open verification window).
    if (state === 'read_only') throw new AppError('SUBSCRIPTION_INACTIVE', 'Subscription inactive.', { state });
  }
}

export async function assertEntitled(db: Db, orgId: string, cls: Entitlement, now: Date): Promise<SubState> {
  const sub = await getSubscription(db, orgId);
  const state = effectiveState(sub, now);
  checkEntitlement(cls, state);
  return state;
}

export function isWritable(state: SubState): boolean {
  try { checkEntitlement('business_write', state); return true; } catch { return false; }
}

/** Persist a state transition with audit and outbox (billing.subscription_changed). */
export async function transition(db: Db, orgId: string, to: SubState, fields: Partial<Omit<SubscriptionRow, 'org_id' | 'state' | 'version'>>, actor: { type: 'user' | 'system' | 'provider'; id: string | null }, requestId?: string | null): Promise<SubState> {
  const cur = await getSubscription(db, orgId, true);
  const sets: string[] = ['state = $2', 'version = version + 1', 'updated_at = now()'];
  const params: unknown[] = [orgId, to];
  for (const [k, v] of Object.entries(fields)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  await db.q(`UPDATE lg.subscriptions SET ${sets.join(', ')} WHERE org_id = $1`, params);
  if (cur.state !== to) {
    await audit(db, { orgId, actorType: actor.type, actorId: actor.id, action: 'billing.state_changed', recordType: 'subscription', recordId: orgId, changedFields: ['state', ...Object.keys(fields)], requestId });
    await emit(db, orgId, 'billing.subscription_changed', { from_state: cur.state, to_state: to });
  }
  return to;
}
