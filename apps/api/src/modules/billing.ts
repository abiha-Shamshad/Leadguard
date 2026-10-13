// API-042..045 Plans, subscription, checkout (explicit authorization) and cancellation.
// Billing provider is BLOCKED (INT-004): BILLING_PROVIDER=none makes checkout return 409 BILLING_NOT_CONFIGURED
// and the pilot uses the managed invoice path (scripts/set-pilot-invoice.ts).
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { AppError, cancelBody, checkoutBody, findPlan, isoOrNull, isoSeconds } from '@leadguard/contracts';
import { BillingUnavailable } from '@leadguard/adapters';
import { effectiveState, emit, getSubscription, isWritable, loadOrgSettings } from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';
import { usage } from '../lib/usage.ts';

const AFTER_TEXT: Record<string, string> = {
  setup_pending: 'Your trial starts when your first source is verified.',
  trialing: 'Your account becomes read-only. You can export your data at any time.',
  pilot_invoice: 'Your pilot is billed by invoice.',
  active: 'Your plan renews automatically.',
  past_due: 'Update your payment method within 7 days to keep full access.',
  read_only: 'Your account is read-only. Export your data or reactivate.',
};

export function registerBilling(app: FastifyInstance, deps: Deps): void {
  // API-042 List plans. While prices are draft the UI shows "Contact us".
  defineRoute(app, deps, {
    op: 'API-042',
    handler: async () => {
      const p = deps.config.plans;
      return {
        data: {
          currency: p.currency, status: p.status,
          items: p.plans.map(x => ({ plan_id: x.plan_id, name: x.name, price_monthly: p.status === 'published' ? x.price_monthly : null, limits: x.limits })),
          note: p.note,
        },
      };
    },
  });

  // API-043 Read subscription. `writable` uses the same guard as write endpoints.
  defineRoute(app, deps, {
    op: 'API-043',
    handler: async ctx => {
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const sub = await getSubscription(ctx.db, ctx.orgId);
      const state = effectiveState(sub, ctx.now);
      const u = await usage(ctx.db, s.timeZone, ctx.now);
      const isOwner = ctx.actor.role === 'owner' && !ctx.actor.support;
      const data: Record<string, unknown> = {
        state,
        plan_id: sub.plan_id,
        plan: findPlan(deps.config.plans, sub.plan_id).name,
        usage: { members: u.members, sources: u.sources, leads_this_month: u.leads_this_month },
        writable: isWritable(state),
        after_trial: AFTER_TEXT[state],
        payment_method: null,
        cancel_at_period_end: sub.cancel_at_period_end,
        export_available: true,
        billing_provider_configured: deps.billing.configured,
      };
      if (sub.trial_ends_at) data.trial = { started_at: isoOrNull(sub.trial_started_at), ends_at: isoSeconds(sub.trial_ends_at), card_on_file: false };
      if (sub.current_period_end) data.current_period_end = isoSeconds(sub.current_period_end);
      if (sub.cancel_at_period_end) data.cancels_on = isoOrNull(sub.current_period_end ?? sub.trial_ends_at);
      if (state === 'past_due' && sub.past_due_since) data.grace_ends_at = isoSeconds(new Date(sub.past_due_since.getTime() + 7 * 86_400_000));
      if (!isOwner) delete data.payment_method;
      return { data };
    },
  });

  // API-044 Start checkout. No charge happens here; `active` only after a verified provider event.
  defineRoute(app, deps, {
    op: 'API-044',
    body: checkoutBody,
    permission: 'billing.manage',
    permissionMessage: 'Only owners can manage billing.',
    handler: async ctx => {
      const b = ctx.body;
      if (b.confirm_plan_and_price !== true) {
        throw new AppError('CONFIRMATION_REQUIRED', 'Confirm the plan and price before continuing to payment.', { fields: { confirm_plan_and_price: 'Must be true.' } });
      }
      // No open redirects: the provider may only send the owner back to LeadGuard's own app origin.
      if (b.return_url && new URL(b.return_url).origin !== new URL(deps.config.appUrl).origin) {
        throw new AppError('VALIDATION_FAILED', 'The return address must be on the LeadGuard app.', { fields: { return_url: `Must start with ${new URL(deps.config.appUrl).origin}.` } });
      }
      if (!deps.billing.configured || !deps.config.flags.self_service_checkout) {
        throw new AppError('BILLING_NOT_CONFIGURED', 'Online payment is not available yet. Contact us to arrange your plan.');
      }
      if (!deps.config.plans.plans.some(p => p.plan_id === b.plan_id)) throw new AppError('VALIDATION_FAILED', 'Choose a listed plan.', { fields: { plan_id: 'Unknown plan.' } });
      const sub = await getSubscription(ctx.db, ctx.orgId, true);
      const open = await ctx.db.maybe(`SELECT 1 FROM lg.audit_events WHERE action = 'billing.checkout_started' AND occurred_at > now() - interval '30 minutes'`);
      if (open) throw new AppError('REQUEST_IN_PROGRESS', 'A checkout is already open. Finish it or wait 30 minutes.');
      let session;
      try {
        session = await deps.billing.createCheckout({
          orgId: ctx.orgId, planId: b.plan_id, returnUrl: b.return_url ?? `${deps.config.appUrl}/settings/billing`,
          idempotencyKey: String(ctx.req.headers['idempotency-key']), customerId: sub.provider_customer_id,
        });
      } catch (e) {
        if (e instanceof BillingUnavailable) throw new AppError('BILLING_PROVIDER_UNAVAILABLE', 'The payment provider is unavailable. Your account is not affected; try again later.');
        throw e;
      }
      if (!sub.provider_customer_id) {
        await ctx.db.q('UPDATE lg.subscriptions SET provider = $2, provider_customer_id = $3, updated_at = now() WHERE org_id = $1', [ctx.orgId, deps.billing.name, session.customerId]);
      }
      await ctx.audit('billing.checkout_started', 'subscription', ctx.orgId);
      await emit(ctx.db, ctx.orgId, 'billing.checkout_started', { plan_id: b.plan_id });
      return {
        status: 201,
        message: 'Continue on the secure payment page.',
        data: { checkout_id: session.checkoutId, provider: deps.billing.name, checkout_url: session.url, expires_at: isoSeconds(new Date(session.expiresAt)), subscription_state: effectiveState(sub, ctx.now) },
      };
    },
  });

  // API-045 Cancel: access continues to period end, then read-only with export. Never hidden behind support.
  defineRoute(app, deps, {
    op: 'API-045',
    body: cancelBody,
    permission: 'billing.manage',
    permissionMessage: 'Only owners can cancel the subscription.',
    handler: async ctx => {
      if (ctx.body.confirm !== true) throw new AppError('CONFIRMATION_REQUIRED', 'Confirm that you want to cancel.');
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const sub = await getSubscription(ctx.db, ctx.orgId, true);
      const state = effectiveState(sub, ctx.now);
      let accessUntil: Date | null = sub.current_period_end ?? sub.trial_ends_at ?? null;
      let pending = false;
      if (state === 'read_only') {
        return { message: 'Your subscription has already ended.', data: { state, cancel_at_period_end: sub.cancel_at_period_end, access_until: isoOrNull(accessUntil), then: 'read_only', export_available: true } };
      }
      if (state === 'setup_pending') accessUntil = ctx.now;
      if (deps.billing.configured && sub.provider_customer_id && ['active', 'past_due'].includes(state)) {
        try { await deps.billing.cancelAtPeriodEnd(sub.provider_customer_id); } catch { pending = true; }
      }
      await ctx.db.q('UPDATE lg.subscriptions SET cancel_at_period_end = true, cancel_reason = $2, version = version + 1, updated_at = now() WHERE org_id = $1',
        [ctx.orgId, ctx.body.reason ?? null]);
      if (state === 'setup_pending' || (!sub.current_period_end && state !== 'trialing')) {
        // Nothing paid to run out: the organization becomes read-only now (export stays available).
        await ctx.db.q(`UPDATE lg.subscriptions SET state = 'read_only', current_period_end = coalesce(current_period_end, $2), version = version + 1 WHERE org_id = $1`, [ctx.orgId, ctx.now]);
        accessUntil = ctx.now;
        await emit(ctx.db, ctx.orgId, 'billing.subscription_changed', { from_state: state, to_state: 'read_only' });
      }
      await ctx.audit('billing.cancel_requested', 'subscription', ctx.orgId, ['cancel_at_period_end']);
      await emit(ctx.db, ctx.orgId, 'billing.cancel_requested', { pending_provider: pending });
      const until = accessUntil ? DateTime.fromJSDate(accessUntil).setZone(s.timeZone).toFormat('LLL d, yyyy') : null;
      return {
        message: pending
          ? 'Cancellation pending - the payment provider is unavailable; we will retry automatically.'
          : until ? `Cancellation scheduled. You keep full access until ${until}.` : 'Cancellation scheduled.',
        data: { state: accessUntil && accessUntil <= ctx.now ? 'read_only' : state, cancel_at_period_end: true, access_until: isoOrNull(accessUntil), then: 'read_only', export_available: true, ...(pending ? { provider_status: 'cancellation_pending' } : {}) },
      };
    },
  });
}
