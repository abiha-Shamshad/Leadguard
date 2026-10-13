# Runbook: suspected cross-organization access

This is a release no-go class incident. Treat as security-critical.

1. Preserve evidence: export `audit_events` for both organizations (actor, action, record, request_id, support_grant_id). Application logs carry request_id, org_id, user_id and route only.
2. Confirm database isolation on a restored copy: `pnpm test:db` (DB-02..DB-07, DB-17, DB-18 must PASS). Check that runtime containers use `lg_app` (NOBYPASSRLS), never `lg_owner` or an admin role.
3. Check support grants (API-050) for the affected org: every support request is audited with its grant ID; expired or revoked grants are denied and audited as `support.access_denied`.
4. Check pagination cursors: they are signed and bound to org and endpoint; a tampered cursor returns 400.
5. If leakage is confirmed: revoke sessions in Clerk for the actor, rotate `CURSOR_SECRET` and `SOURCE_SECRET_ENCRYPTION_KEYS` (prepend a new key), notify the affected customers per the customer terms (OD-04).
