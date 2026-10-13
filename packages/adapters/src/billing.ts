// Billing adapter (INT-004, BLOCKED by OD-05). Section 13.3 interface:
// createCheckout, getSubscription, cancelAtPeriodEnd, verifyWebhook, mapEvent.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertTestDoubleAllowed } from './common.ts';

export interface CheckoutRequest {
  orgId: string;
  planId: string;
  returnUrl: string;
  idempotencyKey: string;
  customerId: string | null;
}

export interface CheckoutSession {
  checkoutId: string;
  url: string;
  expiresAt: string;
  customerId: string;
}

export interface ProviderSubscription {
  status: 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete';
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  planId: string | null;
}

export interface BillingEvent {
  providerEventId: string;
  type: string;
  customerId: string | null;
  subscription: ProviderSubscription | null;
  known: boolean;
}

export class BillingUnavailable extends Error {}

export interface BillingAdapter {
  readonly name: string;
  readonly configured: boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  getSubscription(customerId: string): Promise<ProviderSubscription | null>;
  cancelAtPeriodEnd(customerId: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  mapEvent(body: unknown): BillingEvent;
}

export const noneBillingAdapter: BillingAdapter = {
  name: 'none',
  configured: false,
  async createCheckout() { throw new Error('BILLING_NOT_CONFIGURED'); },
  async getSubscription() { return null; },
  async cancelAtPeriodEnd() { /* nothing to cancel at a provider; the flag is LeadGuard-owned */ },
  verifyWebhook() { return false; },
  mapEvent() { throw new Error('BILLING_NOT_CONFIGURED'); },
};

/** Labelled test double for automated tests: normalized event shape from the API-046 example. */
export function createTestBillingAdapter(opts: { webhookSecret: string }): BillingAdapter & { checkouts: CheckoutRequest[]; cancels: string[] } {
  assertTestDoubleAllowed('billing');
  const checkouts: CheckoutRequest[] = [];
  const cancels: string[] = [];
  return {
    name: 'test_double',
    configured: true,
    checkouts,
    cancels,
    async createCheckout(req) {
      checkouts.push(req);
      return { checkoutId: req.idempotencyKey, url: `https://checkout.provider.example/c/${req.idempotencyKey.slice(0, 8)}`, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), customerId: req.customerId ?? `cus_${req.orgId.slice(0, 8)}` };
    },
    async getSubscription() { return null; },
    async cancelAtPeriodEnd(customerId) { cancels.push(customerId); },
    verifyWebhook(rawBody, headers) {
      const sig = String(headers['x-test-signature'] ?? '');
      const expected = createHmac('sha256', opts.webhookSecret).update(rawBody).digest('hex');
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    },
    mapEvent(body: any) {
      const known = ['subscription.updated', 'subscription.created', 'subscription.deleted', 'invoice.payment_failed', 'invoice.paid'].includes(body?.type);
      const d = body?.data ?? {};
      return {
        providerEventId: String(body?.id ?? ''),
        type: String(body?.type ?? 'unknown'),
        customerId: d.customer_id ?? null,
        known,
        subscription: d.status ? {
          status: d.status,
          currentPeriodEnd: d.current_period_end ? new Date(Number(d.current_period_end) * 1000).toISOString() : null,
          cancelAtPeriodEnd: Boolean(d.cancel_at_period_end),
          planId: d.plan_id ?? null,
        } : null,
      };
    },
  };
}

export function createBillingAdapter(name: string | undefined): BillingAdapter {
  if (!name || name === 'none') return noneBillingAdapter;
  throw new Error(`BILLING_PROVIDER=${name} has no adapter yet (INT-004 BLOCKED). Use BILLING_PROVIDER=none.`);
}
