# Runbook: alerts not delivered

**Signal:** dashboard exception `escalation_not_delivered` / `reminder_not_delivered`, metric `alert_deliveries_total{state=~"failed|unknown"}` > 5 % over 1 hour.

1. In-app deliveries are written at commit and are always `delivered`. Email is BLOCKED until INT-003 - with `EMAIL_PROVIDER=none` no email deliveries exist.
2. `failed`: check `last_error_code` on the delivery (bounce, invalid address). Fix the recipient's email in Clerk.
3. `unknown`: the provider call timed out after sending. It is **never resent automatically**. Ask the recipient, and follow up on the lead directly.
4. Deliveries stuck `pending` for > 2 min are re-enqueued by the sweeper; if they stay pending, check the worker logs and Redis (`/internal/v1/health`).
5. No deliverable channel: add an active manager/owner or adjust notification preferences.
