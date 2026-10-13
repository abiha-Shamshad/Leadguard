// API-046 Billing provider webhook and API-047 Notification delivery webhook (provider class).
// Both are BLOCKED until providers are selected; with provider `none` every request is rejected 401/404 and
// nothing is applied. Signatures are verified on the raw bytes.
import type { FastifyInstance } from 'fastify';
import { getOperation } from '@leadguard/contracts';
import { applyProviderDeliveryEvent, audit, emit, withOrg, withoutOrg, type SubState } from '@leadguard/db';
import { uuidv7 } from '@leadguard/domain';
import type { Deps } from '../deps.ts';
import { registeredOperations } from '../lib/route.ts';

export function registerWebhooks(app: FastifyInstance, deps: Deps): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 262_144 }, (_req, body, done) => done(null, body));

  // ------------------------------------------------------------- API-046
  const billingOp = getOperation('API-046');
  registeredOperations().add(billingOp.id);
  app.post(billingOp.path, { config: { operationId: billingOp.id, entitlement: billingOp.entitlement } }, async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!deps.billing.configured || provider !== deps.billing.name) return reply.code(404).send({ received: false, error: 'unknown_provider' });
    if (!deps.billing.verifyWebhook(raw, req.headers)) return reply.code(401).send({ received: false, error: 'signature_invalid' });
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ received: false, error: 'invalid_json' }); }
    const ev = deps.billing.mapEvent(body);
    if (!ev.providerEventId) return reply.code(400).send({ received: false, error: 'missing_event_id' });

    // The organization comes from LeadGuard's stored provider customer ID, never from metadata alone.
    const org = ev.customerId
      ? await withoutOrg(deps.pool, db => db.maybe<{ org_id: string }>('SELECT org_id FROM lg.resolve_billing_customer($1, $2)', [provider, ev.customerId]))
      : null;
    // billing_events is not tenant-scoped (it can arrive before the org is known); unique provider event ID.
    const inserted = await withOrg(deps.pool, org?.org_id ?? null, null, db => db.maybe<{ id: string }>(
      `INSERT INTO lg.billing_events (id, org_id, provider, provider_event_id, type) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`, [uuidv7(), org?.org_id ?? null, provider, ev.providerEventId, ev.type]));
    if (!inserted) return reply.code(200).send({ received: true, applied: false, duplicate: true });
    if (!ev.known) return reply.code(400).send({ received: true, applied: false, error: 'unknown_event_type' });
    if (!org) return reply.code(200).send({ received: true, applied: false, reason: 'unknown_customer' });

    // Out-of-order events: fetch the subscription from the provider before applying when possible.
    const current = ev.customerId ? (await deps.billing.getSubscription(ev.customerId).catch(() => null)) ?? ev.subscription : ev.subscription;
    const state = await withOrg(deps.pool, org.org_id, null, async db => {
      const sub = await db.one<{ state: SubState; past_due_since: Date | null }>('SELECT state, past_due_since FROM lg.subscriptions WHERE org_id = $1 FOR UPDATE', [org.org_id]);
      let to: SubState = sub.state;
      let pastDue: Date | null = sub.past_due_since;
      if (current) {
        if (current.status === 'active' || current.status === 'trialing') { to = 'active'; pastDue = null; }
        else if (current.status === 'past_due') { to = 'past_due'; pastDue = sub.past_due_since ?? new Date(); }
        else if (current.status === 'canceled') to = 'read_only';
      } else if (ev.type === 'invoice.payment_failed') { to = 'past_due'; pastDue = sub.past_due_since ?? new Date(); }
      await db.q(
        `UPDATE lg.subscriptions SET state = $2, past_due_since = $3, current_period_end = coalesce($4, current_period_end),
                cancel_at_period_end = coalesce($5, cancel_at_period_end), plan_id = coalesce($6, plan_id), version = version + 1, updated_at = now()
          WHERE org_id = $1`,
        [org.org_id, to, pastDue, current?.currentPeriodEnd ?? null, current?.cancelAtPeriodEnd ?? null, current?.planId ?? null]);
      await db.q('UPDATE lg.billing_events SET applied = true, org_id = $2 WHERE id = $1', [inserted.id, org.org_id]);
      await audit(db, { orgId: org.org_id, actorType: 'provider', actorId: provider, action: 'billing.event_applied', recordType: 'subscription', recordId: org.org_id, changedFields: ['state'], requestId: req.requestId });
      if (to !== sub.state) await emit(db, org.org_id, 'billing.subscription_changed', { from_state: sub.state, to_state: to });
      return to;
    });
    return reply.code(200).send({ received: true, applied: true, org_state: state });
  });

  // ------------------------------------------------------------- API-047
  const notifOp = getOperation('API-047');
  registeredOperations().add(notifOp.id);
  app.post(notifOp.path, { config: { operationId: notifOp.id, entitlement: notifOp.entitlement } }, async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!deps.email.configured || provider !== deps.email.name) return reply.code(404).send({ received: false, error: 'unknown_provider' });
    if (!deps.email.verifyWebhook(raw, req.headers)) return reply.code(401).send({ received: false, error: 'signature_invalid' });
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ received: false, error: 'invalid_json' }); }
    const ev = deps.email.mapWebhook(body);
    if (!ev) return reply.code(200).send({ received: true, applied: false, reason: 'ignored_event' });
    const target = await withoutOrg(deps.pool, db => db.maybe<{ org_id: string; delivery_id: string }>('SELECT org_id, delivery_id FROM lg.resolve_delivery_message($1)', [ev.providerMessageId]));
    if (!target) return reply.code(200).send({ received: true, applied: false, reason: 'unknown_message' });
    const r = await applyProviderDeliveryEvent(deps.pool, target.org_id, target.delivery_id, ev.event);
    return reply.code(200).send({ received: true, alert_id: r?.alertId ?? null, channel: r?.channel ?? null, delivery_state: r?.state ?? null });
  });
}
