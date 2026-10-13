# Runbook: billing webhook failure

**Status:** billing provider is BLOCKED (INT-004). With `BILLING_PROVIDER=none` the webhook returns 404 and nothing is applied; the pilot uses `pilot_invoice` set by an operator (`scripts/set-pilot-invoice.ts`).

Once a provider is selected:
1. 401 `signature_invalid`: the `BILLING_WEBHOOK_SECRET` does not match the provider dashboard.
2. Duplicates are safe: `billing_events (provider, provider_event_id)` is unique and replays return `duplicate: true`.
3. Out-of-order events: the adapter re-fetches the subscription from the provider before applying.
4. Missed events: the hourly billing-reconcile job applies trial end, 7-day past-due grace and period-end cancellations from LeadGuard's own rows. Customers are never charged by LeadGuard without explicit checkout confirmation.
