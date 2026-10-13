# LeadGuard Release 1 - Backend

Backend for the **LeadGuard Lead Response Platform, Release 1**, implemented from
`docs/spec/LeadGuard_R1_Implementation_Spec_v1.1.md` (LG-R1-IMPL-1.1.0) and the delivered artifacts
(`db/001_core_schema.sql`, `db/verify_db.mjs`, `domain/*.mjs`, `contracts/api-examples.json`).

One Fastify API service and one worker service from the same codebase (modular monolith), PostgreSQL 17 with
FORCE row-level security as the source of truth, Redis/BullMQ only for wake-ups and rate-limit counters.

## Layout (Section 36.2)

```
leadguard/
  apps/
    api/        Fastify 5 server: routes (modules/) -> shared services -> PostgreSQL
    worker/     outbox publisher, sweeper, BullMQ processors (timers, alerts, exports, health, billing, metrics)
  packages/
    domain/     business-time, ingest-signature, lead transitions, policy schema, contact normalization (pure TS)
    db/         migrations (001 canonical, 002 additive), pools + set_config helper, shared services
    adapters/   email, billing, call, bot-challenge (interfaces, `none`, labelled test doubles), object storage
    contracts/  error catalogue, 52-operation registry, Zod request schemas, envelopes, api-examples.json
  infra/        Dockerfile (one image, two containers), docker-compose, runbooks
  scripts/      set-pilot-invoice.ts (operator CLI)
  docs/spec/    the specification and its checker
```

## Web app (`apps/web`, Section 29)

Next.js 16.4 App Router + TypeScript + TanStack Query, responsive from 360 px phones to desktop. Server
components render page shells (`app/**/page.tsx`); screens live in `views/` and call `/api/v1` with the Clerk
session token. Next proxies `/api/v1` to the API (same origin), so no CORS is needed in development.

| Screen | Route | Operations |
|---|---|---|
| Guided setup | `/setup` | API-003, 013, 015, 014 (polled every 3 s), 008 |
| Needs Action inbox | `/inbox` | API-022, 027 (claim), 028 (log call in a side sheet) |
| Lead detail | `/leads/[id]` | API-025, 026, 028, 029, 030, 031, 032 |
| All leads | `/leads` | API-023 (search terms in the POST body), 024 |
| Alerts | `/alerts` | API-036, 037 |
| Dashboard | `/dashboard` | API-039, 040, 041 |
| Team | `/team` | API-007, 008, 010, 011 |
| Sources | `/sources`, `/sources/[id]` | API-012..019 |
| Follow-up rules | `/rules` | API-033, 034, 035 |
| Organization | `/settings/organization` | API-004, 005, 006 |
| Notifications | `/settings/notifications` | API-038 |
| Subscription + export | `/settings/billing` | API-042..045, 048, 049 |
| Support access | `/settings/support` | API-050..052 |
| Invitation | `/invite#<token>` | API-009 |

Section 29.1 rules in the code: query keys start with `['org', orgId, ...]` and the cache is cleared on org
switch and sign-out (`lib/session.tsx`); actions are disabled while pending and reuse the same Idempotency-Key on
retry (`useCommand` in `lib/hooks.ts`); no optimistic updates; 409 `VERSION_CONFLICT` shows "Changed by someone
else" with Reload and keeps the user's input; every screen has loading, empty, error, read-only and
permission-denied states; Connected is shown only for `verified` sources; no lead data in URLs or browser storage
(only the dev identity, active org ID and a pending invitation token are stored).

Auth: `NEXT_PUBLIC_AUTH_MODE=clerk` uses `@clerk/nextjs` (`<SignIn/>`, `getToken()`); `dev` (default) shows a
development sign-in that matches the API's `AUTH_MODE=dev`.

### Run everything locally (no Docker needed)

```bash
pnpm install
pnpm dev:stack     # embedded PostgreSQL (.data/pg) + migrations + API :3001 + worker
pnpm dev:web       # http://localhost:3000
```

End-to-end browser test (TASK-013, 360 px and 1280 px): `npx playwright install chromium` once, then
`pnpm --filter @leadguard/web test:e2e` with the stack running.

## All 52 operations

Every row of the Section 19 registry is implemented; the API refuses to start if any registry operation has
no route (`assertAllOperationsRegistered`). Route modules:

| Module | Operations |
|---|---|
| `modules/system.ts` | API-001 health, API-002 /me |
| `modules/org.ts` | API-003..006 organization, business hours |
| `modules/team.ts` | API-007..011 members, invitations, roles, deactivation |
| `modules/sources.ts` | API-012..019 sources, verification windows, rotation, disable/enable |
| `modules/ingest.ts` | API-020 form ingest, API-021 call ingest (raw-body signature verification) |
| `modules/inbox.ts`, `modules/leads.ts` | API-022..032 inbox, search, leads, assign, activities, status, snooze, timeline, merge |
| `modules/rules.ts`, `modules/alerts.ts` | API-033..038 policy, preview, alerts, acknowledgement, preferences |
| `modules/dashboard.ts` | API-039..041 summary, exceptions, source health |
| `modules/billing.ts`, `modules/webhooks.ts` | API-042..047 plans, subscription, checkout, cancel, provider webhooks |
| `modules/exports.ts`, `modules/support.ts` | API-048..052 exports, support access grants |

## How the binding rules are enforced

| Rule (spec) | Where |
|---|---|
| Org isolation (7.3, 15) | Every request runs in `withOrg()` -> `set_config('app.org_id', $1, true)`; runtime role `lg_app` is NOBYPASSRLS; pre-context access only via SECURITY DEFINER lookups; outside objects return 404 |
| Idempotency R-IDEM-1..4 (16) | `apps/api/src/lib/route.ts`: key reserved in its own transaction, completed inside the write transaction, deleted on failure; secrets redacted before storage (`redactForReplay`) |
| Entitlement classes (13.2) | `assertEntitled()` inside the request transaction for every route, using the registry class |
| Ingest exactly once (10) | source row locked; `INSERT ... ON CONFLICT (source_id, dedupe_key) DO NOTHING`; duplicates replay the original outcome; every HTTP delivery is a `delivery_attempts` row |
| Never "Connected" without proof (9.2) | `verified` set only by a valid event inside a verification window; re-enable returns to `testing` |
| One alert per timer occurrence (12) | `alerts.timer_id` unique + `ON CONFLICT DO NOTHING`; lead rechecked under lock before firing; deliveries per recipient and channel |
| Redis loss loses nothing (5, 17) | timers claimed from PostgreSQL by the sweeper every 30 s (`FOR UPDATE SKIP LOCKED`); outbox republished; stale deliveries/exports rebuilt; jobs run inline when Redis is down |
| Time is server-owned (11.3) | `addBusinessMinutes` / `parseLocalWallTime` (ported, tested) with the database clock |
| No PII outside the app (32) | no bodies/headers in logs; outbox and queue payloads carry IDs only (tested); search terms in POST bodies; email alerts contain only a link |
| No fake provider success (Appendix E) | `EMAIL_PROVIDER`/`BILLING_PROVIDER`/`BOT_CHALLENGE_PROVIDER` = `none`; email deliveries are not created without a provider; checkout returns 409 `BILLING_NOT_CONFIGURED`; test doubles throw unless `NODE_ENV=test` |

## Run it

Requirements: Node.js 24 (`.nvmrc`), pnpm via corepack, PostgreSQL 17 (16 works), Redis 7 (optional locally).

```bash
corepack enable
pnpm install
cp .env.example .env            # fill in passwords and keys

# 1. Schema + roles (admin connection, once per environment; sets lg_app/lg_scanner passwords)
MIGRATION_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/leadguard \
LG_APP_PASSWORD=app LG_SCANNER_PASSWORD=scanner pnpm db:migrate

# 2. API and worker
pnpm dev:api
pnpm dev:worker
```

Or with containers: see `infra/docker-compose.yml`.

With `AUTH_MODE=dev` (refused in production) requests authenticate with
`Authorization: Bearer dev:<clerk_user_id>:<email>:<name>`; support staff use `devsupport:` plus
`X-Support-Grant-Id`. In production set `AUTH_MODE=clerk` and the Clerk keys (`@clerk/fastify` `clerkPlugin` + `getAuth`).

Example: create an org, a source, and send a signed test event

```bash
H='Authorization: Bearer dev:user_1:owner@example.com:Owner'
curl -s -XPOST localhost:3001/api/v1/organizations -H "$H" -H 'Idempotency-Key: create-org-0001' \
  -H 'Content-Type: application/json' -d '{"name":"Acme Plumbing","time_zone":"America/Chicago"}'
curl -s -XPOST localhost:3001/api/v1/sources -H "$H" -H 'Idempotency-Key: create-src-0001' \
  -H 'Content-Type: application/json' -d '{"type":"web_form_webhook","name":"Website contact form"}'
# then POST /api/v1/sources/{id}/test-event and send the form with X-LeadGuard-Timestamp / X-LeadGuard-Signature
```

## Tests

```bash
pnpm typecheck
pnpm test:domain                  # business-time (RUL-04a..k + port cases), signature (SIG-01..06), transitions, policy
pnpm --filter @leadguard/contracts test   # registry == api-examples.json (52 ops), error catalogue
pnpm --filter @leadguard/api test         # end-to-end against a real PostgreSQL (embedded binary, or TEST_ADMIN_DATABASE_URL)
pnpm test:db                      # delivered verify_db.mjs (19 checks) on a disposable embedded PostgreSQL with 001+002
pnpm smoke                        # builds dist bundles, boots api + worker against a real database, hits HTTP
```

Last local run (Windows, Node 24.20, embedded PostgreSQL 18): typecheck clean; domain 37/37; contracts 3/3;
API/worker end-to-end 26/26; delivered DB checks 19/19; smoke OK.

Issue found while testing the delivered schema: under FORCE RLS, `lg_scanner` cannot
`UPDATE outbox_events SET published_at` (the new row no longer passes the scanner's SELECT policy). 002 adds
`lg.mark_outbox_published(uuid[])` (SECURITY DEFINER) and the publisher uses it.

## Full test pipeline (CI)

`.github/workflows/ci.yml` runs three jobs; `bash scripts/ci-local.sh` runs the same stages locally.

| Stage | What it proves |
|---|---|
| typecheck | Backend packages and web app compile with `strict` TypeScript |
| spec-check | The delivered specification checker CHK-01..12 |
| audit | `pnpm audit --audit-level high` (currently no known vulnerabilities) |
| domain / contracts / worker / web-unit | Business time, signatures, transitions, policy bounds, registry = 52 operations, CSV guard, alert channels, every HTML input pattern valid under the browser `v` flag |
| db-checks | Delivered `verify_db.mjs` DB-01..19 on the migrated schema |
| api-e2e | Enquiry-to-action journey, dedupe under concurrency, alerts, entitlements, export |
| api-contract | **All 52 operations** called against PostgreSQL and compared with `contracts/api-examples.json` (status, response shape, error codes) - report in `docs/evidence/contract-conformance.md` |
| api-security | 401 on every operation without credentials; cross-organization 404 for every object route; role matrix; read-only support grants; NUL/control/prototype input; SQL/LIKE injection; signed cursors; idempotency scoping; open-redirect guard; ingest forgery/replay/oversize; security headers; no contact data in logs, queues or audit; IP rate limiting |
| smoke | Built bundles boot and serve against a real database |
| browser-e2e | Playwright at 360 px and 1280 px: full journey, input constraints, page security headers, no horizontal scroll |

## Security controls

- **API**: FORCE RLS + `lg_app` without BYPASSRLS; 404 for foreign objects; strict Zod schemas (unknown fields rejected);
  NUL/control characters and `__proto__`/`constructor` keys rejected before validation; database data errors map to
  400; 256 KB product body limit, 64 KB ingest limit; per-user (600/min) and failed-auth per-IP (60/min) rate limits;
  `TRUST_PROXY_HOPS` controls X-Forwarded-For trust (default none, so client IPs cannot be spoofed); security headers
  (CSP `default-src 'none'`, nosniff, DENY framing, no-referrer, `Cache-Control: no-store`, HSTS in production);
  checkout `return_url` restricted to the app origin; signed cursors; idempotency keys scoped per org + user + route.
- **Web**: CSP (self-only; Clerk hosts only when Clerk is enabled; `frame-ancestors 'none'`, `object-src 'none'`),
  HSTS in production, Permissions-Policy, COOP; every text box has length, format and required constraints that
  mirror the API (`lib/limits.ts`), and control characters are stripped as the user types.
- Dependency overrides: esbuild pinned to 0.28.2 (GHSA-g7r4-m6w7-qqqr).

## Spec deviations and open items (read before release)

- **Migration 002** (`packages/db/migrations/002_app_extensions.sql`) is additive: 001 stays byte-identical. It adds
  columns the implementation needs (e.g. `memberships.last_assigned_at` for round-robin, `lead_timers.base_at`
  for recomputation after hours changes, `leads.possible_duplicates`, `subscriptions.trial_started_at`) and
  SECURITY DEFINER lookups in the same style as 001 (`user_organizations`, `support_grant_org`,
  `resolve_delivery_message`, `health_stats`, `scan_stale_work`, `scan_orgs`, `scan_sources`).
- **Merge (API-032)** does not physically move rows: `source_events` and `lead_activities` are append-only for
  `lg_app` (001 revokes UPDATE). The merged lead links to the survivor and the survivor's timeline includes it.
  `events_moved` / `activities_moved` report the counts now attached through that link.
- **Invitation emails** cannot be `alert_deliveries` rows (that table requires an alert/timer in 001). Until
  INT-003 the API returns a one-time `invite_url` (redacted on idempotent replay), as TASK-005 allows.
- **Error codes added** where the spec gives an HTTP status without a code: `ALREADY_INVITED` (409),
  `OWNER_INACTIVE` (422), `PAYLOAD_TOO_LARGE` (413), `ORIGIN_NOT_ALLOWED` (403).
- **Business-time port** accepts 1..10080 minutes (follow-up intervals go up to 10080) and fails only after 31
  consecutive closed days; results for the delivered test inputs are unchanged.
- **Inbox "due soon"** contains every owned open lead with an upcoming (or missing) due time, so no open lead is
  invisible; the spec does not define a window.
- **BLOCKED integrations** (Appendix E): email (INT-003), call provider (INT-002), billing (INT-004), bot
  challenge (INT-005). Interfaces, `none` implementations and test doubles exist; real adapters are TASK-014..016.
- **Object storage**: a `local` adapter (signed URLs served by `/files/*`) is provided; a cloud-bucket adapter
  plugs in behind `ObjectStorage` at deploy time.
- **Not in this repository**: the Next.js web app (TASK-013), Node LTS evidence (EV-010), load tests and the
  provider sandbox tests.
