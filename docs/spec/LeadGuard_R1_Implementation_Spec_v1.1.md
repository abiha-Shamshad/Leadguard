---
brand: "LeadGuard"
title: "LeadGuard Lead Response Platform"
subtitle: "Release 1 - Source Ingestion, Needs Action Inbox, Follow-Up Rules, Escalation & Subscription Controls"
tagline: "Implementation-ready specification for the first customer release, written from the CEO Project Direction"
---

| Document item | Binding value |
|---|---|
| Document code | LG-R1-IMPL-1.1.0 (audited revision of 1.0.0) |
| Readiness status | PARTIALLY READY - core tasks ready to implement; email, call, billing and bot-challenge provider integrations BLOCKED until providers are chosen (Appendix E) |
| Product | LeadGuard - lead visibility, ownership and follow-up for small businesses |
| Release | Release 1 of 2 - first customer (pilot) release |
| Primary scope | Organization and team, verified lead sources, Needs Action inbox, lead detail, assignment, business-hours rules, reminders, manager escalation, owner dashboard, subscription state, export |
| Public API root | /api/v1 |
| Ingestion API root | /ingest/v1 (public, source-authenticated) |
| Provider webhook root | /webhooks/v1 |
| Internal API root | /internal/v1 |
| Frontend | Next.js 16.4.x (App Router) + TypeScript + TanStack Query, responsive web |
| Primary backend | Node.js 24 LTS (proposed, DEC-002) + TypeScript + Fastify 5.12.x + Zod 4.6.x - modular monolith |
| Operational database | PostgreSQL 17 (managed) with FORCE row-level security; schema verified on PostgreSQL 16.13 (Appendix H) |
| Async | BullMQ 6.3.x + Redis for wake-ups, alert sending and exports; PostgreSQL outbox and timer rows are authoritative |
| Authentication | Clerk via @clerk/fastify 3.1.x and @clerk/nextjs 7.9.x - LeadGuard owns organizations and roles |
| Authorization | Role-based access (owner, manager, member) + PostgreSQL RLS per organization |
| Notifications | Adapter: in-app + transactional email in R1; staff SMS optional, provider chosen at G0 |
| Billing | Adapter: provider not yet selected; managed invoice path for contracted pilot |
| Call source | Provider-neutral signed-webhook adapter; first provider chosen with the pilot customer |
| AI | None in Release 1 - all rules are deterministic |
| Hosting reference | US region; two app containers + managed PostgreSQL + managed Redis |
| Specification date | 10 October 2026 (v1.1). No release date is set by this document. |

::: callout-green
Binding product decision

LeadGuard is not a CRM, a campaign tool or an AI agent. Release 1 is one complete path from enquiry to action: capture a supported lead, assign an owner, show the next action and due time, alert the right person when the lead is at risk, and keep an accurate history. It must stay small enough for a small office to adopt without a systems specialist.
:::

::: callout-red
MANDATORY TRUST NOTE - READ BEFORE IMPLEMENTATION

A source is supported only when it works with real customer data, rejects forged events, ignores duplicate delivery and passes the acceptance tests. Never display a Connected state that has not been proven by a verified event. Never take a payment without explicit customer authorization. Never let one organization see another organization's leads. These rules outrank every UI or schedule goal in this document.
:::

::: callout-blue
Start here (v1.1)

Status: PARTIALLY READY. Developers start with TASK-001 in Appendix F and follow the task order there. Owner prerequisites before the blocked tasks: confirm the pilot customer and their form tool (OD-01), choose the email provider (INT-003), the bot-challenge provider for embed forms (INT-005), the call provider if used (INT-002) and the billing provider (INT-004). What changed from v1.0 is listed in Appendix I; verification evidence is in Appendix H.
:::

# 1. Executive Scope and Architectural Intent

Release 1 makes every supported incoming lead **visible, owned and followed up**. It is built as one modular TypeScript service with one PostgreSQL database, so a small team can run it reliably and cheaply.

-   **One workflow, end to end:** source event -> lead -> owner -> due time -> reminder -> manager escalation -> history.

-   **Deterministic rules:** assignment, business hours, due times and escalation are configuration plus code. No AI in Release 1.

-   **Verified sources only:** a website form path and, only if the pilot customer uses one, one call source. Each source must pass a live test event before it shows as Connected.

-   **No duplicate business outcomes:** a duplicate delivery of the same provider event never creates a second lead, timer or alert; pending alerts are cancelled when the lead is already handled. An email already accepted by the provider cannot be recalled.

-   **Isolated organizations:** every row carries `org_id`, protected by service checks and PostgreSQL FORCE RLS.

-   **Factual reporting:** the dashboard counts what happened (leads, first-action times, overdue items). It never estimates recovered revenue.

-   **Billing behind an adapter:** the payment provider is not selected. Subscription state is LeadGuard-owned; a managed invoice path supports a contracted pilot.

::: callout-orange
Why this is deliberately small

The CEO direction rules out a CRM replacement, a connector catalogue, a generic automation builder, outbound campaigns, AI agents and native apps in the first release. Every one of those would multiply integration and support cost before the core workflow is proven with a paying customer. Release 1 has 52 HTTP operations, not a platform.
:::

# 2. CEO Direction Traceability

Every requirement in the CEO Project Direction maps to a release control in this document.

| CEO requirement | Implementation in this document | Verified by |
|---|---|---|
| One complete path from enquiry to action | Sections 9-13, API-020 to API-037 | E2E-01 real-lead journey |
| Feel simple without a specialist | Guided setup flow (Section 29), three-question inbox | UX-01 unaided setup test |
| Supported source = works with real data, handles failure and duplicates | Source lifecycle (Section 9), ingest contracts API-020, API-021 | SRC-01..SRC-08 |
| Never display a false Connected state | `verified` status only after a test event (API-015) | SRC-03 |
| First screen: what needs action, who owns it, what next | Inbox contract (API-022) | UX-02 |
| Due time in customer time zone | Server computes UTC due instants from org time zone (Section 11) | RUL-04 DST cases |
| History explains every reminder and escalation | Timeline with rule and policy version (API-031) | AUD-02 |
| Deterministic rules, no AI | Rule engine (Section 11) | RUL-01..RUL-08 |
| Duplicate event creates no second lead or alert | `source_events` unique key (Section 10), one alert per timer occurrence (Section 12) | SRC-05, ALR-03 |
| Alert cancelled when lead already handled | Execution-time recheck (Section 12) | ALR-04 |
| Organizations isolated; roles govern access | RLS + RBAC (Section 7) | SEC-01..SEC-06 |
| Support access limited, authorized and logged | Support grants (API-050 to API-052) | SEC-07 |
| Minimum contact data; no PII in demos, analytics URLs or logs | Data minimization (Section 32) | PRV-01..PRV-04 |
| Safe state when a provider fails | Source health, alert failure states, billing grace (Sections 9, 12, 13) | REC-01..REC-05 |
| No card or charge without explicit authorization | Billing adapter rules (Section 13) | BIL-02 |
| Subscription, plan limits, cancellation, export in plain language | Billing and export contracts API-042 to API-049 | BIL-01..BIL-06 |
| Expired or cancelled subscription not writable | Entitlement classes (Section 13.2) | BIL-04 |
| Pilot measures baseline vs after | Pilot metrics (Section 37) | PIL-01 |

# 3. Two-Release Delivery Plan

| Release | Goal | Included | Exit condition |
|---|---|---|---|
| Release 1 - first customer (this document) | Prove the enquiry-to-action workflow with a real customer | Org/team, web form source, optional one call source, inbox, lead detail, assignment, rules, reminders, escalation, dashboard, subscription state, export, support access | Real enquiry from a verified source reaches the right org, gets an owner and due time, is actioned, and produces the correct manager alert if unresolved - on mobile and desktop |
| Release 2 - self-service growth | Sell without engineering help | Self-service checkout on the selected provider, additional verified sources, PWA push alerts, staff SMS alerts, usage-based plan limits | Pilot value confirmed, pricing validated in the USD 50-200 range, provider and terms approved |

# 4. Release 1 Functional Scope and Non-Goals

-   **Organization and team:** create organization, set time zone and business hours, invite members, assign roles (owner, manager, member), deactivate members.

-   **Sources:** guided creation of a website form source (signed webhook or hosted embed) and, if the pilot uses one, one call source through the provider-neutral call adapter. Test event, delivery log, secret rotation, disable.

-   **Leads:** automatic creation from verified events, manual creation, contact fields, assignment, status changes, contact attempts and notes, snooze/reschedule, timeline, duplicate merge.

-   **Rules:** one follow-up policy per organization: first-response target, follow-up cadence, assignment mode, escalation delay and escalation recipients, all inside business hours.

-   **Alerts:** in-app and email reminders to the owner; escalation to managers; acknowledgement; cancellation when the lead is handled.

-   **Dashboard:** factual counts - new leads, first action time, overdue items, unassigned items, source health, unresolved exceptions.

-   **Subscription and export:** plan and trial state, payment choice, cancellation, read-only after expiry, full CSV export.

::: callout-blue
Explicit Release 1 non-goals

No CRM pipeline or deal management. No project management. No employee monitoring or productivity scoring. No connector catalogue or generic automation builder. No outbound calling, SMS campaigns or AI-written outreach. No autonomous AI agents. No revenue-recovery claims. No native mobile apps. No connector for a source the pilot customer does not use.
:::

# 5. Non-Negotiable Architecture Decisions

| Decision | Binding rule |
|---|---|
| Modular monolith | One Fastify API service and one worker service from the same codebase. No microservices in Release 1. |
| PostgreSQL is the source of truth | Leads, timers, alerts, subscription state and audit live in PostgreSQL. Redis holds only job scheduling and rate-limit counters; losing Redis must not lose a lead or an alert decision. |
| Org isolation in the database | Every tenant table has `org_id`, FORCE RLS and composite foreign keys `(org_id, id)`. |
| Ingest is idempotent | `(source_id, dedupe_key)` is unique. Duplicate delivery returns the original result. |
| Alerts are keyed by occurrence | One alert per timer occurrence (`alerts.timer_id` unique); one delivery row per recipient and channel. Execution rechecks lead state before sending. |
| Rules are deterministic | Versioned JSON policy validated by Zod; no user-written code or expressions. |
| Time is server-owned | Due instants are computed on the server in UTC from the org IANA time zone and business-hours version. |
| Billing is an adapter | LeadGuard owns subscription state. Provider events are verified, idempotent and reconciled. |
| No PII outside the app | No contact data in URLs, analytics events, error payloads or logs. |
| Support access is a grant | Support staff see an organization only through a time-bound, owner-approved, audited grant. |

# 6. Target Runtime Topology

    LeadGuard Platform
    |
    +-- Web app (Next.js, responsive)          app.leadguard.io
    |     +-- Clerk session -> Bearer JWT
    |
    +-- API service (Fastify 5, Node.js 24 LTS) api.leadguard.io
    |     +-- /api/v1        product APIs (Clerk JWT)
    |     +-- /ingest/v1     source events (source key + auth mode)
    |     +-- /webhooks/v1   billing / notification provider callbacks
    |     +-- /internal/v1   health (private network only)
    |
    +-- Worker service (same codebase)
    |     +-- outbox publisher + sweeper (lg_scanner role)
    |     +-- BullMQ queues: lead-timers, alert-deliveries, export-builds, source-health, billing-reconcile
    |
    +-- PostgreSQL (managed, FORCE RLS)         source of truth
    +-- Redis (managed)                          BullMQ + rate limits only
    +-- Object storage (private bucket)          export files, 24h signed URLs
    +-- Providers (adapters)                     email, optional SMS, billing, call source

::: callout-blue
Deployment simplification

Run two containers (api, worker) from one image, one managed PostgreSQL and one managed Redis in a US region. Scale the api horizontally only when measured. A second region, Kubernetes and a separate ingestion service are not needed for Release 1.
:::

# 7. Authentication, Roles and Organization Isolation

## 7.1 Identity

Clerk owns sign-up, sign-in, password reset, MFA and sessions. LeadGuard stores `users(id, clerk_user_id, email, name)` and owns organizations and memberships. The API verifies the Clerk JWT on every request, then resolves the active membership from LeadGuard's own table.

## 7.2 Roles and permissions

| Permission | Owner | Manager | Member | Purpose |
|---|---|---|---|---|
| org.manage | Yes | - | - | Edit organization, time zone, business hours |
| members.manage | Yes | Yes (not owners) | - | Invite, change role, deactivate |
| sources.manage | Yes | Yes | - | Create, test, rotate, disable sources |
| leads.read | All | All | Assigned + unassigned | Inbox, list, detail, timeline |
| leads.write | All | All | Assigned | Edit, activity, status, snooze |
| leads.assign | Yes | Yes | Self-claim unassigned only | Assignment |
| rules.manage | Yes | Yes | - | Follow-up policy |
| dashboard.read | Yes | Yes | - | Owner dashboard |
| billing.manage | Yes | - | - | Plan, payment choice, cancellation |
| exports.create | Yes | - | - | Full data export |
| support.grant | Yes | - | - | Approve support access |

## 7.3 Isolation rules

-   Every request runs inside a transaction that sets `app.org_id` and `app.user_id` with `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`. `SET LOCAL ... = $1` cannot take a bind parameter in PostgreSQL (verified, DB-01). Missing context returns no rows (DB-02).

-   The application database role has no BYPASSRLS. Migrations use a separate owner role not available to running containers.

-   Workers read `org_id` from the durable job row, never from the queue payload alone.

-   An object outside the caller's organization returns 404, never 403, so record existence is not disclosed.

-   Before org context exists, the API uses only the narrow SECURITY DEFINER lookups in Section 15.2 (`resolve_source`, `user_memberships`, `resolve_invitation`, `resolve_billing_customer`, `active_support_grant`, `bootstrap_organization`, `upsert_user`). The request body can never choose an organization.

# 8. Source-of-Truth and Data Ownership Matrix

| Domain | Canonical store | Owner module | Rule |
|---|---|---|---|
| User identity, MFA, sessions | Clerk | identity | LeadGuard stores only the Clerk user ID and email |
| Organization, membership, roles | PostgreSQL | org | One membership per user per org |
| Business hours and holidays | PostgreSQL | org | Versioned; leads keep the version used |
| Sources and secrets | PostgreSQL (secret hashed / encrypted) | sources | Secret shown once on creation or rotation |
| Source events (canonical, one per dedupe key) | PostgreSQL `source_events` | ingest | Unique (source_id, dedupe_key) |
| Delivery attempts (every HTTP delivery) | PostgreSQL `delivery_attempts` | ingest | Repeatable rows; body hash only, no payload |
| Leads | PostgreSQL | leads | Versioned; status via transition endpoint only |
| Lead activities | PostgreSQL | leads | Append-only; corrections are new activities |
| Follow-up policy | PostgreSQL | rules | Versioned JSON; one active version |
| Timers | PostgreSQL `lead_timers` (one row per occurrence) + BullMQ delayed job | rules | PostgreSQL row is authoritative; job is a wake-up |
| Alerts (logical decision) | PostgreSQL `alerts` | alerts | One per timer occurrence (unique timer_id) |
| Alert deliveries | PostgreSQL `alert_deliveries` | alerts | One per alert, recipient and channel; holds delivery and acknowledgement state |
| Subscription state | PostgreSQL `subscriptions` | billing | Provider events update it after verification; cancellation is a flag until period end |
| Export files | Private object storage | exports | Expire after 24 hours |
| Audit | PostgreSQL `audit_events` | audit | Insert-only for the app role |

::: callout-blue
Important distinction: source event vs lead

A delivery attempt records one HTTP request (accepted, duplicate, rejected or failed). A source event is the single canonical record for one provider event (dedupe key). A lead is the business record created from, or linked to, a source event. Two concurrent deliveries of the same provider event produce one source event and two delivery attempts (verified, DB-08).
:::

# 9. Lead Source Lifecycle

## 9.1 Source types and authentication modes

| Source type | auth_mode | How events arrive | Authentication | When to use |
|---|---|---|---|---|
| web_form_webhook | hmac_v1 | Customer's form tool or server POSTs JSON to `/ingest/v1/forms/{sourceKey}` | LeadGuard v1 signature (Section 9.4) | Tools or servers that can compute an HMAC |
| web_form_webhook | secret_header | Same endpoint | Fixed header `X-LeadGuard-Source-Secret: <secret>`, constant-time compare | Tools that can add a custom header but cannot sign |
| web_form_embed | embed | LeadGuard embed script posts from the visitor's browser | Public source key + exact origin allowlist + server-verified bot challenge + rate limits + honeypot | Sites without a webhook-capable form tool |
| call_webhook | provider-defined | Call provider POSTs to `/ingest/v1/calls/{sourceKey}` | The selected provider's documented signature (INT-002) | Only if the pilot customer uses a call source |

::: callout-orange
Forged-event rule for browser forms

A browser form cannot hold a secret. Origin checks, a bot challenge and rate limits reduce abuse but do not prove that an enquiry is genuine: a person can submit false details through the real form. Embed sources are labelled `embed` in the delivery log, and sales must not describe them as forgery-proof. Which mode the pilot uses depends on the pilot's actual form tool (OD-01); the secret in `secret_header` mode is weaker than `hmac_v1` because it travels with every request and has no replay window.
:::

## 9.2 Source status machine

| Status | Meaning | Ingest behaviour | Shown to customer as |
|---|---|---|---|
| draft | Created, never tested | 409 `SOURCE_NOT_VERIFIED` unless a verification window is open | Not connected - send a test event |
| testing | Verification window open or re-enabled | Valid events inside the window create a test lead and set `verified` | Waiting for test event (live step checklist) |
| verified | A valid event was processed inside a verification window | Normal | Connected (with last event time) |
| failing | 3 consecutive rejected deliveries, or silence longer than the window (default 72 business hours) | Normal - valid events still create leads | Needs attention (shows last error) |
| disabled | Turned off by a manager | 410 `SOURCE_DISABLED` | Disabled - events are rejected |

Rules:

-   Only `verified` displays as Connected. `failing` returns to `verified` after the next accepted event.

-   `disabled -> testing` happens only through API-019; it never jumps to `verified`.

-   Signature, schema and rate-limit failures are recorded in `delivery_attempts` with a stable reason code and no payload.

-   Secret rotation keeps the previous secret valid for 24 hours.

## 9.3 Canonical inbound event (LeadGuard internal contract)

All adapters normalize provider payloads to this shape before lead logic runs. This is LeadGuard's own contract; provider payloads are mapped into it by each adapter.

    {
      "source_id": "0b0a7f3c-51d2-7a8e-9f10-2c4d6e8a1b3c",
      "dedupe_key": "form:wpf_entry_8841",
      "occurred_at": "2026-10-14T15:42:10Z",
      "kind": "form_submission",
      "contact": {
        "name": "Dana Morales",
        "email": "dana.morales@example.com",
        "phone": "+15125550142"
      },
      "message": "Water heater leaking, need someone today.",
      "attributes": { "service": "plumbing", "zip": "78704" }
    }

`dedupe_key` is the provider's event or entry ID prefixed with the event family (`form:`, `call:`). When none exists it is `hash:` + hex SHA-256 of `source_id | email_norm | phone_e164 | message | occurred_at truncated to the minute`. Maximum 200 characters.

## 9.4 LeadGuard webhook signature v1 (hmac_v1)

    X-LeadGuard-Timestamp: 1792000000                       (unix seconds)
    X-LeadGuard-Signature: v1=<lowercase hex HMAC-SHA256(secret, "<timestamp>.<raw body bytes>")>

-   The server captures the raw request bytes before JSON parsing and verifies against them; re-serialized JSON fails (tested, SIG-03).

-   Reject when the timestamp is more than 300 seconds from server time, when headers are missing, or when no secret matches. Compare with `crypto.timingSafeEqual`.

-   During rotation both the current and previous secret are tried until `prev_secret_valid_until`.

-   Reference implementation and tests: `domain/ingest-signature.mjs` (6 tests passed on Node 22.22.2, Appendix H).

# 10. Ingest Pipeline, Deduplication and Lead Matching

    POST /ingest/v1/forms/{sourceKey}
      -> SELECT * FROM lg.resolve_source($sourceKey)           (no org context yet; returns org_id)
           not found -> 404 ; disabled -> 410
      -> verify auth for the source's auth_mode                  (failure -> 401/403, attempt logged)
      -> validate + normalize payload (Zod, libphonenumber-js)   (failure -> 400, attempt logged)
      -> BEGIN; set_config('app.org_id', org_id, true)
           entitlement check (class ingest, Section 13.2)        (failure -> 423 or 409, attempt logged)
           INSERT source_events ... ON CONFLICT (source_id, dedupe_key) DO NOTHING
             conflict -> load the original row; outcome replayed; duplicate = true
             new      -> match open lead (rules below)
                           one match  -> link event, activity "repeat enquiry"         outcome lead_linked
                           none       -> create lead, assign, compute due_at, timers   outcome lead_created
                           2+ leads   -> create lead with possible_duplicates flag     outcome lead_created
           INSERT delivery_attempts (result accepted | duplicate)
           audit + outbox (lead.created | lead.repeat_enquiry)
         COMMIT
      -> 201 (lead_created) or 200 (lead_linked, duplicate)

Matching rules:

-   Candidate leads: same organization, status in new, attempted, contacted, qualified, created in the last 30 days, with equal `phone_e164` or equal `email_norm`.

-   If all candidates are the same lead, link to it. If phone and email point to different leads, create a new lead and record both as `possible_duplicates`; a person merges with API-032. Automatic merge never happens.

-   Phone numbers are parsed with libphonenumber-js using the organization's country (US default). Unparseable values are stored in `phone_raw` and flagged; a lead needs at least one of email, E.164 phone or raw phone (database CHECK).

-   Maximum body 64 KB; at most 20 attributes of 500 characters each; unknown fields beyond that are dropped and counted in the attempt record.

-   The response is sent after commit. A provider retry after a network timeout hits the unique key and receives the original lead ID (DB-08).

# 11. Deterministic Follow-Up Rules and Business Hours

## 11.1 Follow-up policy

One active policy version per organization (`follow_up_policies.is_current`). Default created at organization setup:

    {
      "version": 1,
      "assignment": { "mode": "round_robin", "eligible_roles": ["member", "manager"] },
      "first_response": { "target_minutes": 15, "business_hours_only": true },
      "follow_up": { "attempt_intervals_minutes": [60, 240, 1440], "max_attempts": 4 },
      "escalation": { "after_overdue_minutes": 30, "notify": ["managers"], "repeat": false },
      "unassigned_escalation_minutes": 10
    }

Bounds: `target_minutes` 5-1440; `attempt_intervals_minutes` 1-6 entries, each 15-10080; `max_attempts` 1-6; `after_overdue_minutes` 5-1440; `unassigned_escalation_minutes` 5-240. Unknown keys are rejected.

## 11.2 Assignment and recipient decision table

| Situation | Result |
|---|---|
| round_robin, eligible active members exist | Member with the oldest `last_assigned_at` among eligible roles; ties broken by user ID |
| round_robin, no eligible active member | Lead stays unassigned; unassigned escalation timer starts |
| fixed_owner, owner active | That owner |
| fixed_owner, owner deactivated | Unassigned; dashboard exception "Fixed owner inactive" |
| unassigned_queue | Unassigned; any member may claim (API-027) |
| Escalation notify `managers`, no active manager | Owners receive it |
| Escalation recipient is the lead owner | Still notified as escalation recipient; listed once per channel |
| Recipient has email disabled | In-app only; escalations always include in-app |
| Recipient has no deliverable channel | Dashboard exception `escalation_not_delivered` |

## 11.3 Due time calculation

-   Clock authority: the database server time (`now()`), in UTC.

-   Business minutes are counted only inside open intervals of the organization's current business-hours version, in its IANA time zone; holidays are closed days.

-   The canonical calculator is `domain/business-time.mjs` (`addBusinessMinutes`); it passed 11 tests including holidays, weekends, before-opening arrival and the 1 November 2026 DST change (Appendix H).

-   If no open interval exists in the next 31 days, the lead is created with `due_at = null` and a dashboard exception "No business hours configured".

-   User-entered local times (snooze) use `parseLocalWallTime`, which rejects DST-gap times (`LOCAL_TIME_IN_DST_GAP`) and repeated times (`LOCAL_TIME_AMBIGUOUS`). Luxon by itself silently shifts gap times forward (checked locally), so this guard is required.

-   Changing business hours or time zone recomputes `due_at` of pending timers; each change is written to the lead timeline.

## 11.4 Timers

Each timer row is one occurrence: `(lead_id, kind, cycle)` is unique and only one pending timer per lead and kind exists (DB-12).

| Timer kind | Created when | Fires | Cancelled when |
|---|---|---|---|
| first_response_due | Lead created with an owner, or assigned | At due_at | First contact attempt, close, reassignment (replaced with next cycle) |
| follow_up_due | Contact attempt without `reached`/`booked`, while attempts < max_attempts | Next interval in business minutes | Contact made, close, snooze (replaced with next cycle) |
| escalation | A first_response_due or follow_up_due timer fires | Fired timer due_at + after_overdue_minutes (business) | Lead handled before firing |
| unassigned_escalation | Lead created without owner | created + unassigned_escalation_minutes | Lead assigned |

Policy changes: pending timers keep their computed `due_at` and `policy_version`; the next timer created for the lead uses the new version. A reopened lead starts new cycles, so earlier alerts do not suppress new ones.

# 12. Alerts, Reminders and Escalation

## 12.1 Flow

    Every 30 s (sweeper) and on BullMQ wake-up:
      lg_scanner: SELECT id, org_id FROM lg.lead_timers
                  WHERE state = 'pending' AND due_at <= now() ORDER BY due_at LIMIT 100 FOR UPDATE SKIP LOCKED
                  -> UPDATE state = 'claimed', claimed_until = now() + 2 min        (DB-09, DB-10)
      per timer (lg_app, org context from the claimed row):
        BEGIN
          lock lead; recheck: lead open? owner unchanged? timer still claimed by us?
            no  -> timer cancelled (reason), COMMIT, stop
          INSERT alerts (timer_id unique) ON CONFLICT DO NOTHING                     (DB-11)
          INSERT alert_deliveries per recipient x channel (state pending)
          create follow-on timer (escalation or next follow_up cycle)
          timer fired; outbox alert.requested
        COMMIT
      alert-deliveries job per delivery row -> provider adapter

A claimed timer whose `claimed_until` passes without being fired returns to `pending` on the next sweep.

## 12.2 Delivery states (per recipient and channel)

| State | Meaning |
|---|---|
| pending | Created, not yet attempted |
| sending | Worker is calling the provider; `attempts` incremented before the call |
| accepted | Provider accepted the message (has `provider_message_id`) |
| delivered | Provider reported delivery, or in-app notification stored |
| failed | Provider rejected or bounced; `last_error_code` set |
| unknown | Call timed out after sending; outcome not known |
| cancelled | Lead handled before sending |

## 12.3 Failure windows

| Window | Durable evidence | Decision |
|---|---|---|
| Crash before commit | Nothing written | Timer is re-claimed after `claimed_until`; no alert existed |
| After commit, before BullMQ publish | Outbox row unpublished | Publisher republishes; delivery rows still `pending` |
| Job runs twice | Delivery row not `pending` | Second run exits without sending |
| Before provider accepts | Row `sending`, no message ID, provider returned error | Retry if the error is retryable (max 3, exponential backoff 30 s base with jitter) |
| Provider accepted, response lost (timeout) | Row `sending` past 2 min | Set `unknown`; never resend automatically. Reconcile by provider message lookup when INT-003 documents one; otherwise show in exceptions for a manager |
| Lead handled while send in progress | Lead closed, delivery `sending` | Cannot recall an accepted email; timeline shows "sent before lead was handled" |

In-app delivery is a database insert and is always `delivered` at commit.

# 13. Subscription Entitlements and Billing Adapter

## 13.1 Subscription states

| State | Meaning | Customer sees |
|---|---|---|
| setup_pending | Organization created, no verified source yet | Finish setup to start your trial |
| trialing | Trial running (starts when the first source is verified) | Trial - N days left (no card on file) |
| pilot_invoice | Contracted pilot billed by invoice; set by an operator with an audit record | Pilot plan - invoiced |
| active | Paid plan (only after a verified provider event) | Plan name, renewal date; "Cancels on <date>" if `cancel_at_period_end` |
| past_due | Payment failed; 7-day grace from `past_due_since` | Payment failed - update payment method |
| read_only | Trial ended, grace ended or cancellation took effect | Subscription ended - export or reactivate |

Cancellation is not a state: API-045 sets `cancel_at_period_end = true`; the billing-reconcile job moves the organization to `read_only` at `current_period_end`.

## 13.2 Entitlement classes

Every operation has one class (shown in the registry, Section 19). The guard reads `subscriptions` inside the same transaction as the write.

| Class | setup_pending | trialing / pilot_invoice / active / past_due | read_only |
|---|---|---|---|
| read | Allowed | Allowed | Allowed |
| bootstrap (create org, accept invitation, `/me`) | Allowed | Allowed | Allowed |
| setup (org settings, hours, invitations, sources, rules) | Allowed | Allowed | 423 `SUBSCRIPTION_INACTIVE` |
| business_write (lead create, edit, assign, activity, status, snooze, merge) | 423 | Allowed | 423 |
| ingest | Only into a source with an open verification window | Allowed | 423 (see OD-02) |
| control (role change, deactivate, disable source, acknowledge, preferences, checkout, cancel, export, support grant and revoke) | Allowed | Allowed | Allowed |
| provider (billing and notification webhooks) | Always processed after signature verification | | |

-   The verification event in `setup_pending` moves the organization to `trialing` in the same transaction that verifies the source.

-   Reads and export remain available in every state; reactivation is possible from `read_only` through checkout or an operator setting `pilot_invoice`.

## 13.3 Billing adapter

-   Provider not selected (INT-004, BLOCKED). The adapter interface is `createCheckout`, `getSubscription`, `cancelAtPeriodEnd`, `verifyWebhook`, `mapEvent`. Until selection, `BILLING_PROVIDER=none` makes API-044 return 409 `BILLING_NOT_CONFIGURED` and the pilot uses `pilot_invoice`.

-   No card is collected and no charge is created unless the owner starts checkout with `confirm_plan_and_price: true` and confirms on the provider's page; the subscription becomes `active` only after a verified provider event.

-   Provider events are stored in `billing_events` (unique provider event ID) and applied idempotently; the organization is resolved with `lg.resolve_billing_customer()`.

-   Trial length and plan limits are configuration pending leadership approval (OD-03). Examples use a 14-day trial and illustrative limits.

# 14. PostgreSQL Design and Table Ownership

The canonical, executable schema is `db/001_core_schema.sql` (delivered with this specification). It was applied to a disposable PostgreSQL 16.13 database and exercised by 19 checks (Appendix H). Target production version is PostgreSQL 17; no 17-only features are used.

| Table | Owner module | Purpose |
|---|---|---|
| organizations | org | Name, time zone, country |
| users | identity | Global copy of Clerk users; visible only for self and same-org members |
| memberships | org | (org_id, user_id) primary key, role, status |
| business_hours | org | Versioned weekly hours and holidays |
| invitations | org | Token hash, role, expiry, one pending per email |
| sources | sources | Type, auth mode, status, routing key, encrypted secrets |
| verification_windows | sources | 15-minute test windows and step results |
| source_events | ingest | Canonical event per (source_id, dedupe_key) |
| delivery_attempts | ingest | Every HTTP delivery, including duplicates and rejections |
| leads | leads | Contact fields, status, owner, due time, version |
| lead_activities | leads | Append-only history |
| follow_up_policies | rules | Versioned policy JSON |
| lead_timers | rules | Authoritative timer occurrences |
| alerts | alerts | One logical alert per timer occurrence |
| alert_deliveries | alerts | Per recipient and channel delivery and acknowledgement |
| notification_preferences | alerts | Channel choices per member |
| subscriptions, billing_events | billing | Entitlement state and provider events |
| exports | exports | Export jobs and files |
| support_access_grants | support | Time-bound support access (max 72 h, database CHECK) |
| audit_events | audit | Insert-only for the app role |
| outbox_events, idempotency_keys | platform | Reliability tables |

## 14.1 Identifiers

All primary keys are UUIDs (version 7, generated by the application) and the API uses the same UUID strings; there are no prefixed public IDs. Examples in this document use synthetic UUIDs.

## 14.2 Lead status constraint (excerpt from the canonical schema)

    status text NOT NULL DEFAULT 'new'
      CHECK (status IN ('new','attempted','contacted','qualified','won','lost','spam','merged')),
    CHECK ((status = 'merged') = (merged_into IS NOT NULL)),
    CHECK (email_norm IS NOT NULL OR phone_e164 IS NOT NULL OR phone_raw IS NOT NULL)

Reopening is a transition back to `attempted`, not a separate state (Section 30).

# 15. Row-Level Security and Bootstrap Lookups

## 15.1 Policies and roles

| Role | Used by | Access |
|---|---|---|
| lg_owner | Migrations in CI only | Owns all tables; FORCE RLS applies to it |
| lg_app | API and worker | NOBYPASSRLS; policy `org_id = lg.current_org()` on every tenant table |
| lg_scanner | Timer sweeper and outbox publisher | NOBYPASSRLS; may read only pending/claimed timer metadata (id, org_id, kind, due_at, state, claimed_until) and unpublished outbox rows; no access to leads |
| lg_lookup | Owner of lookup functions; cannot log in | BYPASSRLS, used only inside SECURITY DEFINER functions |

    -- set per transaction (bind parameters work with set_config, not with SET LOCAL)
    SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true);

    CREATE POLICY org_isolation ON lg.leads TO lg_app
      USING (org_id = lg.current_org()) WITH CHECK (org_id = lg.current_org());

    CREATE POLICY timer_scan ON lg.lead_timers FOR SELECT TO lg_scanner
      USING (state IN ('pending','claimed'));

A column grant alone would not have let the scanner see any rows under FORCE RLS; the explicit scanner policy plus column grants does (DB-09).

## 15.2 Bootstrap lookups (before org context exists)

| Function | Caller | Returns |
|---|---|---|
| `lg.upsert_user(id, clerk_user_id, email, name)` | Auth middleware on first request | user id |
| `lg.user_memberships(user_id)` | Auth middleware, `/me` | org_id, role, status |
| `lg.bootstrap_organization(org_id, name, tz, country, user_id)` | API-003 | org id; creates owner membership and `setup_pending` subscription; enforces max 3 owned orgs |
| `lg.resolve_source(source_key)` | Ingest | source_id, org_id, type, status, auth_mode |
| `lg.resolve_invitation(token_hash)` | API-009 | invitation_id, org_id, email, role, status, expiry |
| `lg.resolve_billing_customer(provider, customer_id)` | Billing webhook | org_id |
| `lg.active_support_grant(grant_id)` | Support middleware | org_id, scope, expiry (only if active) |

Each function returns only the columns listed and is executable only by `lg_app`. Worker jobs take `org_id` from the claimed database row, never from the queue payload alone.

# 16. Write Consistency, Idempotency and Concurrency

1.  Verify the Clerk session token with `getAuth(request)` from @clerk/fastify (or `verifyToken` for non-request contexts); upsert the user; resolve the active membership with `lg.user_memberships()` and `X-Org-Id`.

2.  Validate the body with the shared Zod schema; compute `request_hash` = SHA-256 of the canonical JSON (keys sorted).

3.  BEGIN; `set_config` org and user context; reserve the idempotency key.

4.  Check the entitlement class (Section 13.2) and the object-level permission.

5.  Apply the change with `WHERE id = $1 AND version = $2`; zero rows -> 409 `VERSION_CONFLICT`.

6.  Append activity, audit and outbox rows in the same transaction; COMMIT.

7.  The outbox publisher enqueues BullMQ jobs after commit; job IDs are row UUIDs (BullMQ rejects custom IDs containing `:`, checked in bullmq 6.3.12 source).

| Control | Rule |
|---|---|
| R-IDEM-1 scope | Key is unique per (org_id, actor_id, route template, key); 8-100 characters; expires after 24 hours |
| R-IDEM-2 replay | Same key and same hash after completion returns the stored status and body; while in progress returns 409 `REQUEST_IN_PROGRESS`; different hash returns 409 `IDEMPOTENCY_KEY_REUSED` |
| R-IDEM-3 secrets | Responses containing a secret (API-013, API-017) are stored with the secret replaced by null and `secret_available: false` |
| R-IDEM-4 failures | A request that fails with 4xx/5xx before commit deletes its in-progress key so the client can retry |
| expected_version | Required on lead edits, status changes, assignment, snooze, org and policy updates |
| Duplicate clicks | UI disables the action while pending and reuses the same key on retry |
| Optimistic UI | Not used for status, assignment or billing |
| Data minimization | Store only name, email, phone, message and up to 20 short attributes; no payment data |

# 17. Asynchronous Architecture: Outbox, BullMQ and Redis

| Component | Responsibility | Not allowed |
|---|---|---|
| Outbox (PostgreSQL) | Durable record of every event to publish; `published_at` set after enqueue | Business state stored only in a queue |
| BullMQ 6.3.x + Redis | Wake-ups, alert delivery, export builds, source health checks | Being the only record of a timer, alert, invitation email or export |
| Worker | Reloads the PostgreSQL row before every side effect | Acting on queue payload without reloading |
| Sweeper (every 30 s) | Claims due timers; releases expired claims; republishes unpublished outbox rows older than 60 s; re-enqueues exports `queued` for more than 10 minutes and deliveries `pending` for more than 2 minutes | Creating alerts outside the timer flow |

| Queue | Payload keys | Retry policy |
|---|---|---|
| lead-timers | timer_id, org_id | Wake-up only; the sweeper is the fallback |
| alert-deliveries | delivery_id, org_id | 3 attempts for retryable provider errors, exponential 30 s base with jitter; timeouts become `unknown` (no retry) |
| export-builds | export_id, org_id | 2 attempts; then `failed` with reason and dashboard exception |
| source-health | source_id, org_id | Every 15 minutes; silence detection |
| billing-reconcile | org_id | Hourly: past_due grace expiry, period-end cancellations, pending checkouts |

Redis loss: all durable work is rebuilt by the sweeper from PostgreSQL rows (timers, outbox, deliveries, exports). Invitation emails are alert-deliveries of kind `invitation`, so they recover the same way.

# 18. API Versioning, Headers and Common Contract

## 18.1 Headers

| Header | Requirement | Purpose |
|---|---|---|
| Authorization: Bearer <Clerk session token> | Required on /api/v1 | Authenticate the user (verified by @clerk/fastify) |
| X-Org-Id | Required when the user belongs to more than one organization | Select the active organization; validated against membership |
| X-Support-Grant-Id | Support staff only | Act under an owner-approved grant |
| X-Request-ID | Optional; server creates if absent | Correlation across API, worker and audit |
| Idempotency-Key | Required on create/side-effect POSTs | Duplicate-effect prevention (R-IDEM-1..4) |
| X-LeadGuard-Timestamp, X-LeadGuard-Signature | hmac_v1 ingest | Section 9.4 |
| X-LeadGuard-Source-Secret | secret_header ingest | Section 9.1 |
| Content-Type: application/json | Required for JSON bodies | UTF-8 JSON |

## 18.2 Envelopes

Product API success:

    {
      "success": true,
      "message": "Lead created.",
      "data": {},
      "meta": { "api_version": "v1", "request_id": "req_01J9X4B7M2", "timestamp": "2026-10-14T15:42:11Z" }
    }

Product API error:

    {
      "success": false,
      "error": {
        "code": "VERSION_CONFLICT",
        "message": "This lead was changed by someone else. Reload to see the latest version.",
        "retryable": false,
        "details": { "current_version": 6 }
      },
      "meta": { "api_version": "v1", "request_id": "req_01J9X4B7M2" }
    }

`message` is optional on success. Ingest and provider webhook endpoints use the minimal envelopes shown in their contracts because the caller is an external system.

## 18.3 Lists, search and time

-   Cursor pagination: default 25, maximum 100; `next_cursor` is opaque, signed and bound to organization and endpoint. The inbox has one cursor per section.

-   Stable sort for every list: primary sort field, then `id`.

-   Search with contact terms uses POST (API-023) so names, emails and phones never appear in URLs or access logs.

-   Timestamps are ISO 8601 UTC. Lead responses also include `due_at_local` formatted in the organization time zone.

-   Breaking changes require `/api/v2`.

## 18.4 Shared example fixture

All examples describe one synthetic organization, Acme Plumbing (America/Chicago, Monday-Friday 08:00-18:00; business-hours version 3 has Saturday closed), owner Chris Patel, member Maria Lopez (there is no active manager, so escalations go to the owner per Section 11.2), leads Dana Morales (website form, 14 October 2026 10:42 CDT) and Greg Hall (overdue, owner Maria). Each example is a snapshot at the `meta.timestamp` it shows; examples are not a continuous sequence unless stated. IDs are synthetic UUIDs.
# 19. Release 1 Endpoint Registry - 52 HTTP Operations

| ID | Method | Path | Purpose | Entitlement |
|---------|--------|------------------------------------------------|------------------------------|------------|
| API-001 | GET | /internal/v1/health | Service health | none |
| API-002 | GET | /api/v1/me | Current user and memberships | read |
| API-003 | POST | /api/v1/organizations | Create organization | bootstrap |
| API-004 | GET | /api/v1/organizations/current | Read organization | read |
| API-005 | PATCH | /api/v1/organizations/current | Update organization | setup |
| API-006 | PUT | /api/v1/organizations/current/business-hours | Replace business hours | setup |
| API-007 | GET | /api/v1/members | List members | read |
| API-008 | POST | /api/v1/invitations | Invite member | setup |
| API-009 | POST | /api/v1/invitations/accept | Accept invitation | bootstrap |
| API-010 | PATCH | /api/v1/members/{memberId} | Change member role | control |
| API-011 | POST | /api/v1/members/{memberId}/deactivate | Deactivate member | control |
| API-012 | GET | /api/v1/sources | List sources | read |
| API-013 | POST | /api/v1/sources | Create source | setup |
| API-014 | GET | /api/v1/sources/{sourceId} | Read source and verification state | read |
| API-015 | POST | /api/v1/sources/{sourceId}/test-event | Start source verification | setup |
| API-016 | GET | /api/v1/sources/{sourceId}/events | Source delivery log | read |
| API-017 | POST | /api/v1/sources/{sourceId}/rotate-secret | Rotate signing secret | setup |
| API-018 | POST | /api/v1/sources/{sourceId}/disable | Disable source | control |
| API-019 | POST | /api/v1/sources/{sourceId}/enable | Re-enable source | setup |
| API-020 | POST | /ingest/v1/forms/{sourceKey} | Receive website form event | ingest |
| API-021 | POST | /ingest/v1/calls/{sourceKey} | Receive call event (provider-neutral) | ingest |
| API-022 | GET | /api/v1/inbox | Needs Action inbox | read |
| API-023 | POST | /api/v1/leads/search | Search and list leads | read |
| API-024 | POST | /api/v1/leads | Create lead manually | business_write |
| API-025 | GET | /api/v1/leads/{leadId} | Read lead | read |
| API-026 | PATCH | /api/v1/leads/{leadId} | Update lead contact details | business_write |
| API-027 | POST | /api/v1/leads/{leadId}/assign | Assign or claim lead | business_write |
| API-028 | POST | /api/v1/leads/{leadId}/activities | Log contact attempt or note | business_write |
| API-029 | POST | /api/v1/leads/{leadId}/status | Change lead status | business_write |
| API-030 | POST | /api/v1/leads/{leadId}/snooze | Reschedule next action | business_write |
| API-031 | GET | /api/v1/leads/{leadId}/timeline | Lead timeline | read |
| API-032 | POST | /api/v1/leads/{leadId}/merge | Merge duplicate lead | business_write |
| API-033 | GET | /api/v1/rules/follow-up-policy | Read follow-up policy | read |
| API-034 | PUT | /api/v1/rules/follow-up-policy | Replace follow-up policy | setup |
| API-035 | POST | /api/v1/rules/follow-up-policy/preview | Preview due times | read |
| API-036 | GET | /api/v1/alerts | List my alerts | read |
| API-037 | POST | /api/v1/alerts/{alertId}/acknowledge | Acknowledge alert | control |
| API-038 | PUT | /api/v1/me/notification-preferences | Set notification preferences | control |
| API-039 | GET | /api/v1/dashboard/summary | Owner dashboard summary | read |
| API-040 | GET | /api/v1/dashboard/exceptions | Unresolved exceptions | read |
| API-041 | GET | /api/v1/dashboard/source-health | Source health | read |
| API-042 | GET | /api/v1/billing/plans | List plans | read |
| API-043 | GET | /api/v1/billing/subscription | Read subscription | read |
| API-044 | POST | /api/v1/billing/checkout | Start checkout (explicit authorization) | control |
| API-045 | POST | /api/v1/billing/cancel | Cancel subscription | control |
| API-046 | POST | /webhooks/v1/billing/{provider} | Billing provider webhook | provider |
| API-047 | POST | /webhooks/v1/notifications/{provider} | Notification delivery webhook | provider |
| API-048 | POST | /api/v1/exports | Request data export | control |
| API-049 | GET | /api/v1/exports/{exportId} | Export status and download | control |
| API-050 | GET | /api/v1/support-access/grants | List support access grants | read |
| API-051 | POST | /api/v1/support-access/grants | Grant support access | control |
| API-052 | POST | /api/v1/support-access/grants/{grantId}/revoke | Revoke support access | control |

::: callout-red
Endpoint result rule

Every operation below shows its request, its success result and at least one error result in the exact envelope the API returns. All IDs, names, phone numbers and emails are synthetic. Examples are independent snapshots of the shared fixture in Section 18.4 unless a sequence is stated. Front-end and QA work from these examples; an endpoint is not done until its live responses match them.
:::

# 20. System and Organization Endpoint Contracts

## API-001 Service health

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /internal/v1/health |
| Purpose | Liveness and readiness for load balancer and uptime monitor; private network only. |
| Permission | None (private network) |
| Entitlement class | none (Section 13.2) |
| Headers | X-Request-ID |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "status": "ready",
      "checks": {
        "postgres": "ok",
        "redis": "ok",
        "outbox_lag_seconds": 2,
        "oldest_pending_timer_seconds": 14
      },
      "version": "1.1.0"
    }

Degraded but still serving (Redis down) (200)

    {
      "status": "degraded",
      "checks": {
        "postgres": "ok",
        "redis": "unavailable",
        "outbox_lag_seconds": 95,
        "oldest_pending_timer_seconds": 140
      },
      "version": "1.1.0"
    }

Error result (503)

    {
      "status": "unavailable",
      "checks": {
        "postgres": "unavailable"
      },
      "version": "1.1.0"
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Ready or degraded - keep the instance in the load balancer |
| 503 | PostgreSQL unavailable - remove the instance |

-   Never returns hostnames, connection strings or error stack traces.

-   Readiness fails only when PostgreSQL is unreachable. Redis loss returns 200 `degraded`, so ingest and lead writes keep working while alerts are delayed and later rebuilt by the sweeper.

-   The uptime monitor alerts on `degraded` from the body; the load balancer only uses the status code.

## API-002 Current user and memberships

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/me |
| Purpose | Return the signed-in user, organizations, role, and effective permissions for the UI. |
| Permission | Authenticated user |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "user": {
          "id": "019a2b27-abca-700f-a4be-ca654d3a0312",
          "name": "Chris Patel",
          "email": "chris@acmeplumbing.com"
        },
        "active_org": {
          "id": "019a2b75-de36-7e2f-80ab-eb21aca45e7a",
          "name": "Acme Plumbing",
          "role": "owner",
          "time_zone": "America/Chicago"
        },
        "organizations": [
          {
            "id": "019a2b75-de36-7e2f-80ab-eb21aca45e7a",
            "name": "Acme Plumbing",
            "role": "owner"
          }
        ],
        "permissions": [
          "org.manage",
          "members.manage",
          "sources.manage",
          "leads.read",
          "leads.write",
          "leads.assign",
          "rules.manage",
          "dashboard.read",
          "billing.manage",
          "exports.create",
          "support.grant"
        ],
        "subscription_state": "trialing",
        "setup_complete": false
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (401)

    {
      "success": false,
      "error": {
        "code": "AUTHENTICATION_REQUIRED",
        "message": "Your session has expired. Sign in again.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 401 | Missing or invalid session |

-   A Clerk user with no membership receives `organizations: []` and is routed to organization setup.

## API-003 Create organization

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/organizations |
| Purpose | First step of guided setup: create the organization and make the caller its owner. |
| Permission | Authenticated user |
| Entitlement class | bootstrap (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Idempotency-Key required. A user may own at most 3 organizations in Release 1. |
| Audit | org.created |
| Domain event | org.created |
| Worker / async | None. |

Request example

    {
      "name": "Acme Plumbing",
      "time_zone": "America/Chicago",
      "country": "US",
      "business_hours": [
        {
          "weekday": "mon",
          "open": "08:00",
          "close": "18:00"
        },
        {
          "weekday": "tue",
          "open": "08:00",
          "close": "18:00"
        },
        {
          "weekday": "wed",
          "open": "08:00",
          "close": "18:00"
        },
        {
          "weekday": "thu",
          "open": "08:00",
          "close": "18:00"
        },
        {
          "weekday": "fri",
          "open": "08:00",
          "close": "18:00"
        }
      ]
    }

Success result (201)

    {
      "success": true,
      "message": "Organization created.",
      "data": {
        "org": {
          "id": "019a2b75-de36-7e2f-80ab-eb21aca45e7a",
          "name": "Acme Plumbing",
          "time_zone": "America/Chicago",
          "country": "US"
        },
        "membership": {
          "role": "owner"
        },
        "subscription": {
          "state": "setup_pending",
          "trial_starts": "after_first_verified_source"
        },
        "follow_up_policy": {
          "version": 1,
          "first_response_minutes": 15
        },
        "setup": {
          "next_step": "connect_source"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (400)

    {
      "success": false,
      "error": {
        "code": "VALIDATION_FAILED",
        "message": "Check the highlighted fields.",
        "retryable": false,
        "details": {
          "fields": {
            "time_zone": "Use a valid IANA time zone such as America/Chicago."
          }
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 201 | Created |
| 200 | Same Idempotency-Key replayed |
| 400 | Invalid time zone or hours |
| 401 | Unauthenticated |
| 409 | Idempotency conflict |
| 422 | ORG_LIMIT_REACHED - user already owns 3 organizations |

-   Creates a default follow-up policy (version 1) so rules work immediately.

-   Trial clock does not start here; it starts after the first verified source (Section 13).

## API-004 Read organization

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/organizations/current |
| Purpose | Organization profile, business hours, setup progress and plan limits. |
| Permission | Any member |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "id": "019a2b75-de36-7e2f-80ab-eb21aca45e7a",
        "name": "Acme Plumbing",
        "time_zone": "America/Chicago",
        "country": "US",
        "business_hours": {
          "version": 2,
          "days": [
            {
              "weekday": "mon",
              "open": "08:00",
              "close": "18:00"
            },
            {
              "weekday": "sat",
              "open": "09:00",
              "close": "13:00"
            }
          ],
          "holidays": [
            "2026-11-26",
            "2026-12-25"
          ]
        },
        "setup": {
          "org_created": true,
          "source_verified": true,
          "team_invited": false,
          "complete": false
        },
        "plan_id": "team",
        "subscription_state": "trialing",
        "limits": {
          "members": {
            "used": 2,
            "max": 10
          },
          "sources": {
            "used": 2,
            "max": 3
          },
          "leads_this_month": {
            "used": 38,
            "max": 1000
          }
        },
        "version": 4
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (404)

    {
      "success": false,
      "error": {
        "code": "NOT_FOUND",
        "message": "Organization not found.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 401 | Unauthenticated |
| 404 | Not a member of this organization |

-   Limits shown are the plan's configured limits; they are never estimated.

## API-005 Update organization

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | PATCH |
| Path | /api/v1/organizations/current |
| Purpose | Change organization name, time zone or country. |
| Permission | org.manage |
| Entitlement class | setup (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | expected_version required. |
| Audit | org.updated (changed field names only) |
| Domain event | org.updated |
| Worker / async | Time-zone change enqueues due-time recomputation for open leads. |

Request example

    {
      "expected_version": 4,
      "time_zone": "America/Denver"
    }

Success result (200)

    {
      "success": true,
      "message": "Organization updated.",
      "data": {
        "id": "019a2b75-de36-7e2f-80ab-eb21aca45e7a",
        "time_zone": "America/Denver",
        "version": 5,
        "recompute": {
          "open_leads": 17,
          "status": "queued"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (409)

    {
      "success": false,
      "error": {
        "code": "VERSION_CONFLICT",
        "message": "Settings were changed by someone else. Reload and try again.",
        "retryable": false,
        "details": {
          "current_version": 5
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Updated |
| 400 | Invalid value |
| 403 | Not permitted |
| 409 | Stale version |
| 423 | Subscription inactive |

-   Existing due instants are recomputed by the worker and each change is written to the lead timeline.

## API-006 Replace business hours

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | PUT |
| Path | /api/v1/organizations/current/business-hours |
| Purpose | Set weekly opening hours and holidays; creates a new business-hours version. |
| Permission | org.manage |
| Entitlement class | setup (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | expected_version required; PUT replaces the whole schedule. |
| Audit | org.business_hours_changed |
| Domain event | org.business_hours_changed |
| Worker / async | Recompute due times for open leads. |

Request example

    {
      "expected_version": 2,
      "days": [
        {
          "weekday": "mon",
          "open": "07:30",
          "close": "18:00"
        },
        {
          "weekday": "tue",
          "open": "07:30",
          "close": "18:00"
        },
        {
          "weekday": "sat",
          "open": null,
          "close": null
        }
      ],
      "holidays": [
        "2026-11-26",
        "2026-12-25"
      ]
    }

Success result (200)

    {
      "success": true,
      "message": "Business hours saved.",
      "data": {
        "business_hours_version": 3,
        "effective_at": "2026-10-14T15:42:11Z",
        "open_leads_recomputed": "queued"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (400)

    {
      "success": false,
      "error": {
        "code": "VALIDATION_FAILED",
        "message": "Opening time must be before closing time.",
        "retryable": false,
        "details": {
          "fields": {
            "days[1].close": "Must be after 07:30."
          }
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Saved |
| 400 | Overlapping or invalid intervals |
| 403 | Not permitted |
| 409 | Stale version |

-   At least one open interval per week is required.

-   Leads keep the business-hours version used for their current due time.

# 21. Team and Invitations Endpoint Contracts

## API-007 List members

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/members |
| Purpose | Team list with role, status and current open-lead load (for assignment). |
| Permission | members.manage or leads.assign |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | status (active\|invited\|deactivated), cursor, limit |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "items": [
          {
            "user_id": "019a2b27-abca-700f-a4be-ca654d3a0312",
            "name": "Chris Patel",
            "email": "chris@acmeplumbing.com",
            "role": "owner",
            "status": "active",
            "open_leads": 4
          },
          {
            "user_id": "019a2b60-717d-7b2a-b059-d6ef5efdcaf8",
            "name": "Maria Lopez",
            "email": "maria@acmeplumbing.com",
            "role": "member",
            "status": "active",
            "open_leads": 9
          },
          {
            "invitation_id": "019a2bff-a1b5-7732-91d9-173c11d4e73f",
            "email": "sam@acmeplumbing.com",
            "role": "member",
            "status": "invited",
            "expires_at": "2026-10-21T15:42:11Z"
          }
        ],
        "next_cursor": null
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (403)

    {
      "success": false,
      "error": {
        "code": "AUTHORIZATION_DENIED",
        "message": "You do not have permission to view the team.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 401 | Unauthenticated |
| 403 | Not permitted |

-   `open_leads` is an exact count of leads owned with status new or attempted.

## API-008 Invite member

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/invitations |
| Purpose | Send an email invitation with a role. |
| Permission | members.manage |
| Entitlement class | setup (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Idempotency-Key required; one pending invitation per email per org. |
| Audit | member.invited |
| Domain event | member.invited |
| Worker / async | alert-deliveries (invitation email). |

Request example

    {
      "email": "sam@acmeplumbing.com",
      "role": "member"
    }

Success result (201)

    {
      "success": true,
      "message": "Invitation sent.",
      "data": {
        "invitation_id": "019a2bff-a1b5-7732-91d9-173c11d4e73f",
        "email": "sam@acmeplumbing.com",
        "role": "member",
        "status": "pending",
        "expires_at": "2026-10-21T15:42:11Z",
        "email_delivery": "queued"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (422)

    {
      "success": false,
      "error": {
        "code": "PLAN_LIMIT_REACHED",
        "message": "Your plan allows 10 team members. Remove a member or change plan.",
        "retryable": false,
        "details": {
          "limit": "members",
          "used": 10,
          "max": 10
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 201 | Created |
| 400 | Invalid email or role |
| 403 | Managers cannot invite owners |
| 409 | Already a member or pending invite |
| 422 | Member limit reached |
| 423 | Subscription inactive |

-   The token is random, stored hashed, single-use and valid for 7 days.

-   `email_delivery: queued` is not a delivery claim; the members list shows delivery failures.

## API-009 Accept invitation

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/invitations/accept |
| Purpose | Signed-in invitee accepts an invitation token. |
| Permission | Authenticated user whose verified email matches the invitation |
| Entitlement class | bootstrap (Section 13.2) |
| Headers | Authorization, X-Request-ID, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Token is single-use; replay by the same user returns the existing membership. |
| Audit | member.joined |
| Domain event | member.joined |
| Worker / async | None. |

Request example

    {
      "token": "lgi_7d3f...redacted"
    }

Success result (200)

    {
      "success": true,
      "message": "You joined Acme Plumbing.",
      "data": {
        "org": {
          "id": "019a2b75-de36-7e2f-80ab-eb21aca45e7a",
          "name": "Acme Plumbing"
        },
        "membership": {
          "role": "member",
          "status": "active"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (410)

    {
      "success": false,
      "error": {
        "code": "INVITATION_EXPIRED",
        "message": "This invitation has expired. Ask your manager to send a new one.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Joined |
| 400 | Malformed token |
| 403 | Email does not match |
| 410 | Expired or revoked |

-   Tokens are passed in the body, never in a URL query parameter after the landing page.

## API-010 Change member role

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | PATCH |
| Path | /api/v1/members/{memberId} |
| Purpose | Change a member's role. |
| Permission | members.manage (only owners can grant or remove owner) |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Content-Type |
| Path / query parameters | memberId (user ID) |
| Idempotency / concurrency | expected_version required. |
| Audit | member.role_changed |
| Domain event | member.role_changed |
| Worker / async | None. |

Request example

    {
      "expected_version": 2,
      "role": "manager"
    }

Success result (200)

    {
      "success": true,
      "message": "Role updated.",
      "data": {
        "user_id": "019a2b60-717d-7b2a-b059-d6ef5efdcaf8",
        "role": "manager",
        "version": 3
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (422)

    {
      "success": false,
      "error": {
        "code": "LAST_OWNER",
        "message": "An organization must keep at least one owner.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Updated |
| 403 | Not permitted |
| 404 | Member not found |
| 409 | Stale version |
| 422 | Would leave the org without an owner |

-   Permission changes apply on the next request; no cached role is trusted for writes.

## API-011 Deactivate member

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/members/{memberId}/deactivate |
| Purpose | Remove access and hand the member's open leads to a chosen person or the unassigned queue. |
| Permission | members.manage |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | memberId |
| Idempotency / concurrency | Idempotency-Key required. |
| Audit | member.deactivated |
| Domain event | member.deactivated |
| Worker / async | Timers for reassigned leads are recomputed. |

Request example

    {
      "reassign_to": "019a2b27-abca-700f-a4be-ca654d3a0312",
      "reason": "Left the company"
    }

Success result (200)

    {
      "success": true,
      "message": "Member deactivated.",
      "data": {
        "user_id": "019a2b60-717d-7b2a-b059-d6ef5efdcaf8",
        "status": "deactivated",
        "leads_reassigned": 9,
        "access_removed": true
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (404)

    {
      "success": false,
      "error": {
        "code": "NOT_FOUND",
        "message": "Member not found.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Deactivated |
| 403 | Not permitted |
| 404 | Not found |
| 422 | Cannot deactivate the last owner |

-   Access ends on the next request because every request re-reads the membership. The Clerk session is not revoked, because the same user may belong to other organizations.

-   The user's history remains in timelines; leads are reassigned in the same transaction and their timers recomputed.

# 22. Sources Endpoint Contracts

## API-012 List sources

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/sources |
| Purpose | Sources with exact status and last event, for setup and source health. |
| Permission | sources.manage or dashboard.read |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "items": [
          {
            "id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
            "name": "Website contact form",
            "type": "web_form_webhook",
            "status": "verified",
            "last_event_at": "2026-10-14T15:42:10Z",
            "verified_at": "2026-10-10T18:03:44Z",
            "events_24h": {
              "accepted": 6,
              "duplicate": 1,
              "rejected": 0
            }
          },
          {
            "id": "019a2bff-3594-7d17-b29f-d05ed26570b5",
            "name": "Office phone line",
            "type": "call_webhook",
            "status": "failing",
            "last_event_at": "2026-10-13T21:10:02Z",
            "last_error": {
              "reason": "SIGNATURE_INVALID",
              "at": "2026-10-14T14:01:12Z",
              "count": 3
            }
          }
        ]
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (403)

    {
      "success": false,
      "error": {
        "code": "AUTHORIZATION_DENIED",
        "message": "Only owners and managers can manage sources.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 403 | Not permitted |

-   Status values are exactly those of Section 9.2; the UI shows Connected only for `verified`.

## API-013 Create source

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/sources |
| Purpose | Create a web form (webhook or embed) or call source; returns the endpoint and the secret once. |
| Permission | sources.manage |
| Entitlement class | setup (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Idempotency-Key required. |
| Audit | source.created |
| Domain event | source.created |
| Worker / async | None. |

Request example

    {
      "type": "web_form_webhook",
      "name": "Website contact form",
      "field_mapping": {
        "name": "full_name",
        "email": "email",
        "phone": "phone",
        "message": "comments"
      }
    }

Success result (201)

    {
      "success": true,
      "message": "Source created. Copy the secret now; it will not be shown again.",
      "data": {
        "source": {
          "id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
          "type": "web_form_webhook",
          "status": "draft"
        },
        "endpoint_url": "https://api.leadguard.io/ingest/v1/forms/sk_live_4f8a2c91",
        "signing_secret": "whsec_9b1e...shown_once",
        "signature": {
          "header": "X-LeadGuard-Signature",
          "algorithm": "HMAC-SHA256",
          "signed_payload": "{timestamp}.{raw_body}"
        },
        "next_step": "send_test_event"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Replay with the same Idempotency-Key (secret is never replayed) (200)

    {
      "success": true,
      "message": "Source already created. The secret is shown only once; rotate it if it was not copied.",
      "data": {
        "source": {
          "id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
          "type": "web_form_webhook",
          "status": "draft"
        },
        "endpoint_url": "https://api.leadguard.io/ingest/v1/forms/sk_live_4f8a2c91",
        "signing_secret": null,
        "secret_available": false,
        "next_step": "rotate_secret_if_not_copied"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (422)

    {
      "success": false,
      "error": {
        "code": "SOURCE_TYPE_NOT_ENABLED",
        "message": "Call sources are enabled only after the provider is verified for your account.",
        "retryable": false,
        "details": {
          "type": "call_webhook"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 201 | Created |
| 200 | Same Idempotency-Key replayed (secret not included) |
| 400 | Invalid type or mapping |
| 403 | Not permitted |
| 422 | Source limit reached or call source not enabled for this org |
| 423 | Subscription inactive |

-   `auth_mode` is `hmac_v1` (default, for tools that can compute a signature), `secret_header` (for tools that can only send a fixed header `X-LeadGuard-Source-Secret`) or `embed`.

-   Embed sources require `allowed_origins` (exact https origins) and return an embed snippet instead of a secret.

-   The plaintext secret is never written to `idempotency_keys`; a replay returns `signing_secret: null` and `secret_available: false`.

-   Call sources require a configured provider adapter (`provider_key`) approved for this organization.

## API-014 Read source and verification state

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/sources/{sourceId} |
| Purpose | Source detail polled by the setup screen while waiting for the test event. |
| Permission | sources.manage |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | sourceId |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
        "name": "Website contact form",
        "type": "web_form_webhook",
        "status": "testing",
        "last_event_at": "2026-10-14T15:42:10Z",
        "verified_at": "2026-10-10T18:03:44Z",
        "events_24h": {
          "accepted": 6,
          "duplicate": 1,
          "rejected": 0
        },
        "verification": {
          "started_at": "2026-10-14T15:30:00Z",
          "expires_at": "2026-10-14T15:45:00Z",
          "steps": [
            {
              "step": "endpoint_reachable",
              "state": "passed"
            },
            {
              "step": "signature_valid",
              "state": "failed",
              "detail": "Signature did not match. Check the signing secret in your form tool."
            },
            {
              "step": "fields_mapped",
              "state": "not_reached"
            },
            {
              "step": "lead_created",
              "state": "not_reached"
            }
          ]
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (404)

    {
      "success": false,
      "error": {
        "code": "NOT_FOUND",
        "message": "Source not found.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 404 | Not found |

-   The steps list shows the exact step that failed, as the CEO direction requires.

## API-015 Start source verification

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/sources/{sourceId}/test-event |
| Purpose | Open a 15-minute verification window; the customer then submits their real form or makes a test call. |
| Permission | sources.manage |
| Entitlement class | setup (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | sourceId |
| Idempotency / concurrency | Idempotency-Key required; an open window is returned instead of a new one. |
| Audit | source.verification_started |
| Domain event | None. |
| Worker / async | Window expiry job. |

Request example

    {
      "window_minutes": 15
    }

Success result (202)

    {
      "success": true,
      "message": "Waiting for your test event.",
      "data": {
        "source_id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
        "status": "testing",
        "verification_id": "019a2ba6-ff69-7a44-a21d-744a5ee3585e",
        "expires_at": "2026-10-14T15:57:11Z",
        "instructions": "Submit your website form once with a real-looking enquiry. It will appear in your inbox marked TEST."
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (409)

    {
      "success": false,
      "error": {
        "code": "SOURCE_DISABLED",
        "message": "Enable this source before testing it.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 202 | Window open |
| 403 | Not permitted |
| 404 | Not found |
| 409 | Source disabled |

-   The first valid event in the window sets the source to `verified`, marks that lead `is_test` (excluded from dashboard counts) and, if the subscription is `setup_pending`, moves it to `trialing` in the same transaction.

-   Without an open window, a `draft` or `testing` source rejects events with 409 `SOURCE_NOT_VERIFIED`, so untested configurations never create real leads.

-   LeadGuard never sends a synthetic event on the customer's behalf; verification proves the real path.

## API-016 Source delivery log

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/sources/{sourceId}/events |
| Purpose | Every delivery attempt with outcome and reason, for investigation and recovery. |
| Permission | sources.manage |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | sourceId; outcome (accepted\|duplicate\|rejected\|failed); cursor; limit |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "items": [
          {
            "event_id": "019a2b62-7626-7ac1-a47c-8c2db24b73ec",
            "received_at": "2026-10-14T15:42:10Z",
            "outcome": "accepted",
            "lead_id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
            "dedupe_key": "form:wpf_entry_8841"
          },
          {
            "event_id": "019a2b10-04ae-7638-a9e9-fa1c0986df63",
            "received_at": "2026-10-14T15:42:41Z",
            "outcome": "duplicate",
            "lead_id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
            "dedupe_key": "form:wpf_entry_8841"
          },
          {
            "event_id": "019a2b1d-c6ab-73f6-b6fe-9c2cbdfce270",
            "received_at": "2026-10-14T13:05:09Z",
            "outcome": "rejected",
            "reason": "SIGNATURE_INVALID",
            "lead_id": null
          }
        ],
        "next_cursor": "c_eyJrIjoiMjAyNi0xMC0xNCJ9"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:43:00Z"
      }
    }

Error result (404)

    {
      "success": false,
      "error": {
        "code": "NOT_FOUND",
        "message": "Source not found.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 404 | Not found |

-   The log shows outcome and reason only; contact details are visible on the linked lead, not in the log.

## API-017 Rotate signing secret

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/sources/{sourceId}/rotate-secret |
| Purpose | Issue a new secret; the previous one stays valid for 24 hours. |
| Permission | sources.manage |
| Entitlement class | setup (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | sourceId |
| Idempotency / concurrency | Idempotency-Key required. |
| Audit | source.secret_rotated |
| Domain event | None. |
| Worker / async | Old-secret expiry job. |

Request example

    {}

Success result (200)

    {
      "success": true,
      "message": "New secret created. Update your form tool within 24 hours.",
      "data": {
        "source_id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
        "signing_secret": "whsec_c41d...shown_once",
        "previous_secret_valid_until": "2026-10-15T15:42:11Z"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (422)

    {
      "success": false,
      "error": {
        "code": "NOT_APPLICABLE",
        "message": "Embed sources do not use a signing secret.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Rotated |
| 403 | Not permitted |
| 404 | Not found |
| 422 | Embed sources have no secret |

-   Secrets are stored encrypted; only a hash prefix is shown afterwards.

## API-018 Disable source

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/sources/{sourceId}/disable |
| Purpose | Stop accepting events from a source. |
| Permission | sources.manage |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | sourceId |
| Idempotency / concurrency | Idempotency-Key required. |
| Audit | source.disabled |
| Domain event | source.disabled |
| Worker / async | None. |

Request example

    {
      "reason": "Replaced by new form"
    }

Success result (200)

    {
      "success": true,
      "message": "Source disabled. New events will be rejected.",
      "data": {
        "source_id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
        "status": "disabled",
        "disabled_at": "2026-10-14T15:42:11Z"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (403)

    {
      "success": false,
      "error": {
        "code": "AUTHORIZATION_DENIED",
        "message": "Only owners and managers can disable sources.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Disabled |
| 403 | Not permitted |
| 404 | Not found |

-   Existing leads from the source are unchanged.

-   Allowed in every subscription state, including read_only (control operation).

-   Re-enable with the next operation; it returns the source to `testing`, never directly to `verified`.

## API-019 Re-enable source

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/sources/{sourceId}/enable |
| Purpose | Turn a disabled source back on; it must be re-verified before showing Connected. |
| Permission | sources.manage |
| Entitlement class | setup (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | sourceId |
| Idempotency / concurrency | Idempotency-Key required; enabling an already-enabled source returns its current state. |
| Audit | source.enabled |
| Domain event | source.enabled |
| Worker / async | None. |

Request example

    {}

Success result (200)

    {
      "success": true,
      "message": "Source enabled. Send a test enquiry to reconnect it.",
      "data": {
        "source_id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
        "status": "testing",
        "next_step": "send_test_event"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (423)

    {
      "success": false,
      "error": {
        "code": "SUBSCRIPTION_INACTIVE",
        "message": "Reactivate your subscription before enabling sources.",
        "retryable": false,
        "details": {
          "state": "read_only"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Enabled |
| 403 | Not permitted |
| 404 | Not found |
| 423 | Subscription read-only |

-   Never returns the source to `verified` directly; the next valid event in a verification window does.

# 23. Ingestion Endpoint Contracts

## API-020 Receive website form event

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /ingest/v1/forms/{sourceKey} |
| Purpose | Public endpoint for signed webhooks and embed submissions; creates or links a lead. |
| Permission | Source key + HMAC signature (webhook) or origin + bot challenge (embed) |
| Entitlement class | ingest (Section 13.2) |
| Headers | hmac_v1: X-LeadGuard-Timestamp + X-LeadGuard-Signature; secret_header: X-LeadGuard-Source-Secret; embed: Origin + challenge token; Content-Type |
| Path / query parameters | sourceKey (public routing key, not a secret) |
| Idempotency / concurrency | Unique (source_id, dedupe_key). Duplicate delivery returns the original result. |
| Audit | lead.created by system actor `source:<id>` |
| Domain event | lead.created or lead.repeat_enquiry |
| Worker / async | lead-timers for first response and unassigned escalation. |

Request example

    {
      "entry_id": "wpf_entry_8841",
      "submitted_at": "2026-10-14T15:42:10Z",
      "full_name": "Dana Morales",
      "email": "dana.morales@example.com",
      "phone": "(512) 555-0142",
      "comments": "Water heater leaking, need someone today.",
      "service": "plumbing",
      "zip": "78704"
    }

Success result (201)

    {
      "accepted": true,
      "outcome": "lead_created",
      "event_id": "019a2b62-7626-7ac1-a47c-8c2db24b73ec",
      "lead_id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
      "duplicate": false,
      "request_id": "req_01J9X4B7M2"
    }

Duplicate delivery result (same entry_id) (200)

    {
      "accepted": true,
      "outcome": "lead_created",
      "event_id": "019a2b62-7626-7ac1-a47c-8c2db24b73ec",
      "lead_id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
      "duplicate": true,
      "request_id": "req_01J9X4B7M2"
    }

Repeat enquiry linked to an open lead (200)

    {
      "accepted": true,
      "outcome": "lead_linked",
      "event_id": "019a2bf7-6dee-768c-91df-593c8a806eb6",
      "lead_id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
      "duplicate": false,
      "request_id": "req_01J9X4B7M2"
    }

Error result (401)

    {
      "accepted": false,
      "error": {
        "code": "SIGNATURE_INVALID",
        "message": "Signature verification failed.",
        "retryable": false
      },
      "request_id": "req_01J9X4B7M2"
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 201 | New lead created |
| 200 | Linked to an open lead, or duplicate (original result replayed) |
| 409 | SOURCE_NOT_VERIFIED - source not verified and no verification window open |
| 400 | Payload invalid after mapping |
| 401 | Signature invalid or timestamp outside 5 minutes |
| 403 | Origin not allowed / challenge failed |
| 404 | Unknown source key |
| 410 | Source disabled |
| 413 | Body over 64 KB |
| 423 | Subscription inactive |
| 429 | Rate limited |

-   Ingest responses use a minimal envelope (no organization data) because the caller is an external system.

-   Signature `hmac_v1` is LeadGuard's own scheme: `v1=` + lowercase hex HMAC-SHA256 of `{timestamp}.{raw body bytes}`, 300-second tolerance, constant-time compare, previous secret accepted for 24 h after rotation (reference code verified: domain/ingest-signature.mjs).

-   Embed submissions reduce abuse but cannot prove the enquiry is genuine; they are labelled `embed` in the delivery log and sales must not call them forgery-proof.

-   Response is sent only after commit, so a retry after a network timeout is safe.

-   At least one of email or phone is required; otherwise 400 `CONTACT_REQUIRED` and the event is logged as rejected.

## API-021 Receive call event (provider-neutral)

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /ingest/v1/calls/{sourceKey} |
| Purpose | Call provider webhook; the adapter maps provider fields to the canonical event. Missed or short calls create or link a lead. |
| Permission | Source key + provider signature verified by the adapter. INTEGRATION STATUS: BLOCKED until the pilot call provider is chosen (INT-002) |
| Entitlement class | ingest (Section 13.2) |
| Headers | Provider signature header(s) as documented by the selected provider, Content-Type |
| Path / query parameters | sourceKey |
| Idempotency / concurrency | Unique (source_id, provider_call_id + event_type). |
| Audit | lead.created / lead.call_logged |
| Domain event | lead.created or lead.activity_added |
| Worker / async | lead-timers. |

Request example

    {
      "_note": "LeadGuard normalized call event (test double). Real provider payload and signature are defined in INT-002 after provider selection.",
      "provider": "pilot_call_provider",
      "call_id": "CA7f3e19b2",
      "event_type": "call.completed",
      "direction": "inbound",
      "from": "+15125550199",
      "to": "+15125550100",
      "started_at": "2026-10-14T16:02:00Z",
      "duration_seconds": 0,
      "answered": false,
      "voicemail": true
    }

Success result (201)

    {
      "accepted": true,
      "outcome": "lead_created",
      "event_id": "019a2bce-2788-70ae-92e6-cc0c1f946b75",
      "lead_id": "019a2bba-e56f-7f81-98e4-e10dc32b8147",
      "duplicate": false,
      "classification": "missed_call",
      "request_id": "req_01J9X4B7M2"
    }

Answered call logged on an existing lead (200)

    {
      "accepted": true,
      "outcome": "activity_logged",
      "event_id": "019a2b2f-4e08-7a37-a169-a70f1c5c5b91",
      "lead_id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
      "duplicate": false,
      "classification": "answered_call_logged",
      "request_id": "req_01J9X4B7M2"
    }

Error result (400)

    {
      "accepted": false,
      "error": {
        "code": "PAYLOAD_UNMAPPABLE",
        "message": "Required field 'from' missing after provider mapping.",
        "retryable": false
      },
      "request_id": "req_01J9X4B7M2"
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 201 | New lead created |
| 200 | Linked, activity logged, or duplicate |
| 400 | Unmappable payload |
| 401 | Provider signature invalid |
| 404 | Unknown source key |
| 410 | Source disabled |
| 423 | Subscription inactive |
| 429 | Rate limited |

-   Missed and voicemail calls create a lead (or link to an open lead with the same number); answered calls longer than 30 seconds are logged as contact activity, not new leads.

-   Recording and transcription are not stored in Release 1.

-   Provider-specific field names and signature schemes come from that provider's published documentation only; they are added at G0 when the pilot provider is known.

# 24. Inbox and Leads Endpoint Contracts

## API-022 Needs Action inbox

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/inbox |
| Purpose | First screen: what needs action now, who owns it and what happens next. |
| Permission | leads.read |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | view (mine\|team); section (overdue\|due_soon\|unassigned) + cursor to page one section; limit (default 25, max 100) |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "counts": {
          "overdue": 3,
          "due_soon": 5,
          "unassigned": 2
        },
        "sections": {
          "overdue": [
            {
              "id": "019a2b90-99ae-7aca-87ef-56a19f56ae4f",
              "name": "Greg Hall",
              "source": "Website contact form",
              "owner": "Maria Lopez",
              "next_action": "Second call attempt",
              "due_at_local": "Oct 14, 9:30 AM CDT",
              "overdue_minutes": 72,
              "escalated": true,
              "version": 5
            }
          ],
          "due_soon": [
            {
              "id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
              "name": "Dana Morales",
              "source": "Website contact form",
              "owner": "Chris Patel",
              "next_action": "First call",
              "due_at_local": "Oct 14, 10:57 AM CDT",
              "due_in_minutes": 15,
              "version": 1
            }
          ],
          "unassigned": [
            {
              "id": "019a2bba-e56f-7f81-98e4-e10dc32b8147",
              "name": null,
              "phone_masked": "(512) ***-0199",
              "source": "Office phone line",
              "next_action": "Return missed call",
              "waiting_minutes": 6,
              "version": 1
            }
          ]
        },
        "cursors": {
          "overdue": null,
          "due_soon": null,
          "unassigned": null
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (401)

    {
      "success": false,
      "error": {
        "code": "AUTHENTICATION_REQUIRED",
        "message": "Your session has expired. Sign in again.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 401 | Unauthenticated |

-   Members see their own and unassigned leads; managers and owners can switch to the team view.

-   Each section is bounded (25 items) with its own cursor; counts are exact.

## API-023 Search and list leads

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/leads/search |
| Purpose | Filter and search leads; contact search terms travel in the body, never the URL. |
| Permission | leads.read |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Content-Type |
| Path / query parameters | None (body) |
| Idempotency / concurrency | Read-only POST; no Idempotency-Key. |
| Audit | lead.searched (no terms recorded) |
| Domain event | None. |
| Worker / async | None. |

Request example

    {
      "query": "morales",
      "status": [
        "new",
        "attempted",
        "contacted"
      ],
      "owner_id": null,
      "source_id": null,
      "created_from": "2026-10-01",
      "limit": 25,
      "cursor": null
    }

Success result (200)

    {
      "success": true,
      "data": {
        "items": [
          {
            "id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
            "name": "Dana Morales",
            "status": "new",
            "owner": "Chris Patel",
            "source": "Website contact form",
            "created_at": "2026-10-14T15:42:11Z",
            "due_at_local": "Oct 14, 10:57 AM CDT"
          }
        ],
        "next_cursor": null
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (400)

    {
      "success": false,
      "error": {
        "code": "VALIDATION_FAILED",
        "message": "Search text must be at least 2 characters.",
        "retryable": false,
        "details": {
          "fields": {
            "query": "Minimum 2 characters."
          }
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 400 | Invalid filter |
| 429 | Rate limited |

-   Search uses trigram indexes on name and normalized email/phone within the caller's organization only.

## API-024 Create lead manually

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/leads |
| Purpose | Record a walk-in or phone enquiry that did not come from a connected source. |
| Permission | leads.write |
| Entitlement class | business_write (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Idempotency-Key required. Possible duplicates are returned as warnings, not blocked. |
| Audit | lead.created (actor = user) |
| Domain event | lead.created |
| Worker / async | lead-timers. |

Request example

    {
      "name": "Kim Nguyen",
      "phone": "512-555-0177",
      "email": null,
      "message": "Quote for bathroom remodel",
      "owner_id": "me"
    }

Success result (201)

    {
      "success": true,
      "message": "Lead created.",
      "data": {
        "id": "019a2b65-d5d3-7663-bf0a-583c85ce4684",
        "status": "new",
        "contact": {
          "name": "Kim Nguyen",
          "email": null,
          "phone": "+15125550177"
        },
        "message": "Quote for bathroom remodel",
        "source": {
          "id": null,
          "name": "Manual entry",
          "type": "manual"
        },
        "owner": {
          "user_id": "019a2b27-abca-700f-a4be-ca654d3a0312",
          "name": "Chris Patel"
        },
        "next_action": "First call",
        "due_at": "2026-10-14T15:57:10Z",
        "due_at_local": "Oct 14, 10:57 AM CDT",
        "due_state": "due_soon",
        "first_action_at": null,
        "version": 1,
        "created_at": "2026-10-14T15:42:11Z",
        "possible_duplicates": [
          {
            "id": "019a2b1f-05ce-7b73-9a45-9390a12b130a",
            "name": "Kim Nguyen",
            "status": "lost",
            "created_at": "2026-08-02T14:00:00Z"
          }
        ]
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (423)

    {
      "success": false,
      "error": {
        "code": "SUBSCRIPTION_INACTIVE",
        "message": "Your subscription has ended. Leads are read-only; export your data or reactivate.",
        "retryable": false,
        "details": {
          "state": "read_only"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 201 | Created |
| 400 | Email or phone required |
| 403 | Not permitted |
| 409 | Idempotency conflict |
| 422 | Monthly lead limit reached |
| 423 | Subscription inactive |

-   Manual leads follow the same assignment and due-time rules as source leads.

## API-025 Read lead

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/leads/{leadId} |
| Purpose | Lead detail with the one primary action, due time, owner and allowed actions. |
| Permission | leads.read |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | leadId |
| Idempotency / concurrency | Read-only; returns `version` for later writes. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
        "status": "new",
        "contact": {
          "name": "Dana Morales",
          "email": "dana.morales@example.com",
          "phone": "+15125550142"
        },
        "message": "Water heater leaking, need someone today.",
        "source": {
          "id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
          "name": "Website contact form",
          "type": "web_form_webhook"
        },
        "owner": {
          "user_id": "019a2b27-abca-700f-a4be-ca654d3a0312",
          "name": "Chris Patel"
        },
        "next_action": "First call",
        "due_at": "2026-10-14T15:57:10Z",
        "due_at_local": "Oct 14, 10:57 AM CDT",
        "due_state": "due_soon",
        "first_action_at": null,
        "version": 1,
        "created_at": "2026-10-14T15:42:11Z",
        "attributes": {
          "service": "plumbing",
          "zip": "78704"
        },
        "primary_action": {
          "label": "Call Dana",
          "type": "call",
          "tel": "+15125550142"
        },
        "allowed_actions": [
          "log_activity",
          "assign",
          "change_status",
          "snooze",
          "merge"
        ],
        "allowed_statuses": [
          "attempted",
          "contacted",
          "lost",
          "spam"
        ],
        "timers": [
          {
            "kind": "first_response_due",
            "due_at": "2026-10-14T15:57:10Z",
            "state": "pending"
          }
        ],
        "events": [
          {
            "event_id": "019a2b62-7626-7ac1-a47c-8c2db24b73ec",
            "kind": "form_submission",
            "received_at": "2026-10-14T15:42:10Z"
          }
        ]
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (404)

    {
      "success": false,
      "error": {
        "code": "NOT_FOUND",
        "message": "Lead not found.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 401 | Unauthenticated |
| 404 | Not found or not visible to this member |

-   `allowed_actions` and `allowed_statuses` are computed server-side; the UI never infers them.

## API-026 Update lead contact details

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | PATCH |
| Path | /api/v1/leads/{leadId} |
| Purpose | Correct name, email, phone, message or next action text. |
| Permission | leads.write |
| Entitlement class | business_write (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Content-Type |
| Path / query parameters | leadId |
| Idempotency / concurrency | expected_version required. |
| Audit | lead.updated (field names only) |
| Domain event | lead.updated |
| Worker / async | None. |

Request example

    {
      "expected_version": 2,
      "contact": {
        "phone": "+15125550143"
      },
      "next_action": "Call after 2 PM"
    }

Success result (200)

    {
      "success": true,
      "message": "Lead updated.",
      "data": {
        "id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
        "contact": {
          "name": "Dana Morales",
          "email": "dana.morales@example.com",
          "phone": "+15125550143"
        },
        "next_action": "Call after 2 PM",
        "version": 3
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (409)

    {
      "success": false,
      "error": {
        "code": "VERSION_CONFLICT",
        "message": "This lead was changed by someone else. Reload to see the latest version.",
        "retryable": false,
        "details": {
          "current_version": 3
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Updated |
| 400 | Invalid phone/email |
| 403 | Not owner and not manager |
| 404 | Not found |
| 409 | Stale version |
| 423 | Subscription inactive |

-   Status, owner and due time cannot be changed here; they have explicit endpoints.

## API-027 Assign or claim lead

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/leads/{leadId}/assign |
| Purpose | Assign an owner (managers) or claim an unassigned lead (members). |
| Permission | leads.assign (members: self-claim of unassigned only) |
| Entitlement class | business_write (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | leadId |
| Idempotency / concurrency | Idempotency-Key + expected_version. |
| Audit | lead.assigned |
| Domain event | lead.assigned |
| Worker / async | Cancel unassigned escalation; recompute first-response timer for the new owner. |

Request example

    {
      "expected_version": 1,
      "owner_id": "019a2b60-717d-7b2a-b059-d6ef5efdcaf8",
      "note": "Maria covers south Austin"
    }

Success result (200)

    {
      "success": true,
      "message": "Lead assigned to Maria Lopez.",
      "data": {
        "id": "019a2bba-e56f-7f81-98e4-e10dc32b8147",
        "owner": {
          "user_id": "019a2b60-717d-7b2a-b059-d6ef5efdcaf8",
          "name": "Maria Lopez"
        },
        "due_at": "2026-10-14T16:17:00Z",
        "due_at_local": "Oct 14, 11:17 AM CDT",
        "timers_cancelled": [
          "unassigned_escalation"
        ],
        "version": 2
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T16:02:30Z"
      }
    }

Error result (409)

    {
      "success": false,
      "error": {
        "code": "ALREADY_CLAIMED",
        "message": "Chris Patel claimed this lead a moment ago.",
        "retryable": false,
        "details": {
          "owner_id": "019a2b27-abca-700f-a4be-ca654d3a0312",
          "current_version": 2
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Assigned |
| 403 | Member cannot assign to others |
| 404 | Lead or member not found |
| 409 | Stale version / already claimed |
| 422 | Owner inactive |

-   Two members claiming at once: the guarded update lets exactly one succeed.

## API-028 Log contact attempt or note

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/leads/{leadId}/activities |
| Purpose | Record a call, text, email, visit or note with an outcome, and set what happens next - without leaving the inbox. |
| Permission | leads.write |
| Entitlement class | business_write (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | leadId |
| Idempotency / concurrency | Idempotency-Key required; expected_version required when the activity changes status or timers. |
| Audit | lead.activity_added |
| Domain event | lead.activity_added |
| Worker / async | Timer recalculation; pending reminder or escalation cancelled when contact is made. |

Request example

    {
      "expected_version": 1,
      "type": "call",
      "outcome": "no_answer",
      "note": "Left voicemail",
      "occurred_at": "2026-10-14T15:50:00Z"
    }

Success result (201)

    {
      "success": true,
      "message": "Call logged. Next attempt due 11:50 AM.",
      "data": {
        "activity": {
          "id": "019a2b17-7f51-7845-858d-8c4abe9c1c37",
          "type": "call",
          "outcome": "no_answer",
          "occurred_at": "2026-10-14T15:50:00Z",
          "by": "Chris Patel"
        },
        "lead": {
          "id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
          "status": "attempted",
          "first_action_at": "2026-10-14T15:50:00Z",
          "next_action": "Follow-up attempt 2",
          "due_at_local": "Oct 14, 11:50 AM CDT",
          "version": 2
        },
        "timers": {
          "cancelled": [
            "first_response_due"
          ],
          "created": [
            "follow_up_due"
          ]
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:50:05Z"
      }
    }

Result when contact is made (outcome = reached) (201)

    {
      "success": true,
      "message": "Marked contacted. Pending reminders cancelled.",
      "data": {
        "activity": {
          "id": "019a2b32-1a2d-73d6-b07e-7d259d79d02e",
          "type": "call",
          "outcome": "reached"
        },
        "lead": {
          "id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
          "status": "contacted",
          "next_action": null,
          "due_at": null,
          "version": 3
        },
        "timers": {
          "cancelled": [
            "follow_up_due",
            "escalation"
          ],
          "created": []
        },
        "alerts_cancelled": 1
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:50:05Z"
      }
    }

Error result (400)

    {
      "success": false,
      "error": {
        "code": "VALIDATION_FAILED",
        "message": "Activity time cannot be in the future.",
        "retryable": false,
        "details": {
          "fields": {
            "occurred_at": "Must be on or before now."
          }
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 201 | Logged |
| 400 | Invalid type/outcome or future time |
| 403 | Not permitted |
| 404 | Not found |
| 409 | Stale version |
| 423 | Subscription inactive |

-   Outcomes: reached, no_answer, voicemail, wrong_number, booked, not_interested, note.

-   `reached` or `booked` moves the lead to contacted and cancels pending timers and alerts in the same transaction.

-   Manual activities are self-reported; provider-confirmed call events are labelled separately in the timeline.

## API-029 Change lead status

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/leads/{leadId}/status |
| Purpose | Move the lead through its states (qualified, won, lost, spam, reopen). |
| Permission | leads.write |
| Entitlement class | business_write (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | leadId |
| Idempotency / concurrency | Idempotency-Key + expected_version. |
| Audit | lead.status_changed |
| Domain event | lead.status_changed |
| Worker / async | Closing statuses cancel all timers and pending alerts. |

Request example

    {
      "expected_version": 3,
      "to_status": "won",
      "reason": "Booked water heater replacement"
    }

Success result (200)

    {
      "success": true,
      "message": "Lead marked won.",
      "data": {
        "id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
        "status": "won",
        "previous_status": "contacted",
        "closed_at": "2026-10-14T17:20:00Z",
        "timers_cancelled": 0,
        "version": 4
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T17:20:01Z"
      }
    }

Error result (422)

    {
      "success": false,
      "error": {
        "code": "INVALID_TRANSITION",
        "message": "A lead cannot move from 'new' to 'won'. Log contact first.",
        "retryable": false,
        "details": {
          "from": "new",
          "to": "won",
          "allowed": [
            "attempted",
            "contacted",
            "lost",
            "spam"
          ]
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Changed |
| 403 | Not permitted |
| 404 | Not found |
| 409 | Stale version |
| 422 | Transition not allowed or reason missing |

-   Allowed transitions are listed in Section 30. `lost` and `spam` require a reason.

-   Won/lost are factual outcomes; no revenue value is calculated.

## API-030 Reschedule next action

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/leads/{leadId}/snooze |
| Purpose | Set a new due time for the next action (e.g. customer asked for a call tomorrow). |
| Permission | leads.write |
| Entitlement class | business_write (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | leadId |
| Idempotency / concurrency | Idempotency-Key + expected_version. |
| Audit | lead.rescheduled |
| Domain event | lead.rescheduled |
| Worker / async | Replace follow-up timer; cancel pending escalation. |

Request example

    {
      "expected_version": 2,
      "due_at_local": "2026-10-15T09:00",
      "reason": "Customer asked for a call tomorrow morning"
    }

Success result (200)

    {
      "success": true,
      "message": "Rescheduled for Oct 15, 9:00 AM.",
      "data": {
        "id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
        "next_action": "Follow-up call",
        "due_at": "2026-10-15T14:00:00Z",
        "due_at_local": "Oct 15, 9:00 AM CDT",
        "version": 3
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (400)

    {
      "success": false,
      "error": {
        "code": "LOCAL_TIME_AMBIGUOUS",
        "message": "1:30 AM happens twice on Nov 1 because clocks move back. Choose another time.",
        "retryable": false,
        "details": {
          "due_at_local": "2026-11-01T01:30"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Rescheduled |
| 400 | Past, more than 30 days ahead, DST gap or ambiguous time |
| 404 | Not found |
| 409 | Stale version |
| 422 | Lead closed |

-   Local time is interpreted in the organization time zone by `parseLocalWallTime()` (domain/business-time.mjs, tested): DST-gap times return `LOCAL_TIME_IN_DST_GAP` and repeated times return `LOCAL_TIME_AMBIGUOUS`; times in the past or more than 30 days ahead return `VALIDATION_FAILED`.

-   A reason is required so the timeline explains why no reminder fired.

## API-031 Lead timeline

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/leads/{leadId}/timeline |
| Purpose | Plain-language history explaining every event, action, reminder and escalation. |
| Permission | leads.read |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | leadId, cursor, limit |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "items": [
          {
            "at": "2026-10-14T15:42:10Z",
            "type": "event_received",
            "text": "Enquiry received from Website contact form"
          },
          {
            "at": "2026-10-14T15:42:11Z",
            "type": "assigned",
            "text": "Assigned to Chris Patel by round-robin rule (policy v3)"
          },
          {
            "at": "2026-10-14T15:42:11Z",
            "type": "due_set",
            "text": "First response due 10:57 AM CDT (15 min target, business hours v2)"
          },
          {
            "at": "2026-10-14T15:57:10Z",
            "type": "reminder",
            "text": "Reminder to Chris Patel - first response overdue (policy v3, first_response_due cycle 1)",
            "alert_id": "019a2ba7-3575-71d3-ade9-139e71cf3166",
            "deliveries": [
              {
                "recipient": "Chris Patel",
                "channel": "in_app",
                "state": "delivered"
              },
              {
                "recipient": "Chris Patel",
                "channel": "email",
                "state": "delivered"
              }
            ]
          },
          {
            "at": "2026-10-14T16:27:10Z",
            "type": "escalation",
            "text": "Escalated to owner (no active manager) - overdue 30 min (policy v3, escalation cycle 1)",
            "alert_id": "019a2b07-dcae-7091-95f4-8632a56c187a",
            "deliveries": [
              {
                "recipient": "Chris Patel",
                "channel": "in_app",
                "state": "delivered"
              },
              {
                "recipient": "Chris Patel",
                "channel": "email",
                "state": "accepted"
              }
            ]
          },
          {
            "at": "2026-10-14T16:31:00Z",
            "type": "activity",
            "text": "Chris Patel logged a call: reached (self-reported)"
          },
          {
            "at": "2026-10-14T16:31:00Z",
            "type": "timer_cancelled",
            "text": "Follow-up reminder cancelled - lead contacted"
          }
        ],
        "next_cursor": null
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T16:32:00Z"
      }
    }

Error result (404)

    {
      "success": false,
      "error": {
        "code": "NOT_FOUND",
        "message": "Lead not found.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 404 | Not found |

-   Every reminder or escalation line names the rule step and policy version that caused it.

-   Email shows `accepted` when the provider accepted it and `delivered` only after a provider delivery event; it never claims delivery that was not confirmed.

## API-032 Merge duplicate lead

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/leads/{leadId}/merge |
| Purpose | Merge a duplicate lead into this lead, keeping both histories. |
| Permission | leads.write (manager or owner) |
| Entitlement class | business_write (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | leadId (the surviving lead) |
| Idempotency / concurrency | Idempotency-Key required. |
| Audit | lead.merged |
| Domain event | lead.merged |
| Worker / async | Cancel timers and alerts of the merged lead. |

Request example

    {
      "merge_lead_id": "019a2bba-e56f-7f81-98e4-e10dc32b8147",
      "expected_version": 3,
      "merge_expected_version": 2
    }

Success result (200)

    {
      "success": true,
      "message": "Leads merged.",
      "data": {
        "id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
        "merged_lead_id": "019a2bba-e56f-7f81-98e4-e10dc32b8147",
        "events_moved": 1,
        "activities_moved": 2,
        "merged_lead_status": "merged",
        "version": 4
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T16:40:00Z"
      }
    }

Error result (422)

    {
      "success": false,
      "error": {
        "code": "MERGE_NOT_ALLOWED",
        "message": "You cannot merge a lead into itself.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Merged |
| 403 | Not permitted |
| 404 | Either lead not found |
| 409 | Stale version |
| 422 | Cannot merge a lead into itself or a closed lead |

-   The merged lead becomes read-only with status `merged` and a link to the survivor; nothing is deleted.

# 25. Rules and Alerts Endpoint Contracts

## API-033 Read follow-up policy

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/rules/follow-up-policy |
| Purpose | Current active policy and its version. |
| Permission | leads.read (read), rules.manage (edit in UI) |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "version": 3,
        "assignment": {
          "mode": "round_robin",
          "eligible_roles": [
            "member",
            "manager"
          ]
        },
        "first_response": {
          "target_minutes": 15,
          "business_hours_only": true
        },
        "follow_up": {
          "attempt_intervals_minutes": [
            60,
            240,
            1440
          ],
          "max_attempts": 4
        },
        "escalation": {
          "after_overdue_minutes": 30,
          "notify": [
            "managers"
          ],
          "repeat": false
        },
        "unassigned_escalation_minutes": 10,
        "updated_by": "Chris Patel",
        "updated_at": "2026-10-10T18:20:00Z"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (401)

    {
      "success": false,
      "error": {
        "code": "AUTHENTICATION_REQUIRED",
        "message": "Your session has expired. Sign in again.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 401 | Unauthenticated |

-   Members see the policy read-only so they understand why reminders happen.

## API-034 Replace follow-up policy

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | PUT |
| Path | /api/v1/rules/follow-up-policy |
| Purpose | Save a new policy version. |
| Permission | rules.manage |
| Entitlement class | setup (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | expected_version required. |
| Audit | rules.policy_changed |
| Domain event | rules.policy_changed |
| Worker / async | New leads use the new version; open leads keep their version until their next timer step. |

Request example

    {
      "expected_version": 3,
      "assignment": {
        "mode": "fixed_owner",
        "owner_id": "019a2b60-717d-7b2a-b059-d6ef5efdcaf8"
      },
      "first_response": {
        "target_minutes": 10,
        "business_hours_only": true
      },
      "follow_up": {
        "attempt_intervals_minutes": [
          60,
          1440
        ],
        "max_attempts": 3
      },
      "escalation": {
        "after_overdue_minutes": 20,
        "notify": [
          "owners",
          "managers"
        ],
        "repeat": false
      },
      "unassigned_escalation_minutes": 10
    }

Success result (200)

    {
      "success": true,
      "message": "Follow-up rules saved (version 4).",
      "data": {
        "version": 4,
        "active_from": "2026-10-14T15:42:11Z",
        "applies_to": "new leads and next timer step of open leads"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (400)

    {
      "success": false,
      "error": {
        "code": "VALIDATION_FAILED",
        "message": "First response target must be between 5 and 1440 minutes.",
        "retryable": false,
        "details": {
          "fields": {
            "first_response.target_minutes": "5-1440"
          }
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Saved |
| 400 | Schema violation |
| 403 | Not permitted |
| 409 | Stale version |

-   Strict schema: unknown keys rejected; no expressions, scripts or URLs.

-   Bounds: target 5-1440 min, max 6 attempts, escalation 5-1440 min.

## API-035 Preview due times

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/rules/follow-up-policy/preview |
| Purpose | Show when a lead arriving at a given moment would be due and escalated, before saving. |
| Permission | rules.manage |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only computation; no writes. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Request example

    {
      "policy": {
        "first_response": {
          "target_minutes": 15,
          "business_hours_only": true
        },
        "escalation": {
          "after_overdue_minutes": 30
        }
      },
      "arrival_local": "2026-10-16T17:55"
    }

Success result (200)

    {
      "success": true,
      "data": {
        "arrival_local": "Fri Oct 16, 5:55 PM CDT",
        "business_hours_version": 3,
        "business_hours_status": "closes 6:00 PM; Saturday closed",
        "first_response_due_local": "Mon Oct 19, 8:10 AM CDT",
        "explanation": "5 business minutes remain Friday; the remaining 10 minutes start at Monday 8:00 AM opening.",
        "escalation_at_local": "Mon Oct 19, 8:40 AM CDT"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (400)

    {
      "success": false,
      "error": {
        "code": "LOCAL_TIME_IN_DST_GAP",
        "message": "That local time does not exist because clocks move forward. Choose another time.",
        "retryable": false,
        "details": {
          "arrival_local": "2027-03-14T02:30"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 400 | Invalid policy or time |

-   Uses exactly the same calculator as production timers.

## API-036 List my alerts

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/alerts |
| Purpose | In-app reminders and escalations for the current user. |
| Permission | leads.read |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | state (open\|acknowledged\|all), cursor, limit |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "items": [
          {
            "id": "019a2b07-dcae-7091-95f4-8632a56c187a",
            "kind": "escalation",
            "lead_id": "019a2baa-c642-761d-8dea-0c9e4b02af72",
            "lead_name": "Dana Morales",
            "text": "Overdue 30 min - owner Chris Patel",
            "created_at": "2026-10-14T16:27:10Z",
            "my_deliveries": [
              {
                "channel": "in_app",
                "state": "delivered"
              },
              {
                "channel": "email",
                "state": "accepted"
              }
            ],
            "acknowledged": false
          }
        ],
        "unread": 1,
        "next_cursor": null
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T16:28:00Z"
      }
    }

Error result (401)

    {
      "success": false,
      "error": {
        "code": "AUTHENTICATION_REQUIRED",
        "message": "Your session has expired. Sign in again.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 401 | Unauthenticated |

-   Alerts for leads the user can no longer see are hidden.

## API-037 Acknowledge alert

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/alerts/{alertId}/acknowledge |
| Purpose | Mark an alert as seen; does not change the lead. |
| Permission | Alert recipient |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | alertId |
| Idempotency / concurrency | Idempotent: repeat returns the same acknowledgement. |
| Audit | alert.acknowledged |
| Domain event | None. |
| Worker / async | None. |

Request example

    {}

Success result (200)

    {
      "success": true,
      "message": "Alert acknowledged. The lead is still overdue.",
      "data": {
        "id": "019a2b07-dcae-7091-95f4-8632a56c187a",
        "acknowledged_by": "019a2b27-abca-700f-a4be-ca654d3a0312",
        "acknowledged_at": "2026-10-14T16:29:40Z",
        "lead_still_overdue": true
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T16:29:41Z"
      }
    }

Error result (404)

    {
      "success": false,
      "error": {
        "code": "NOT_FOUND",
        "message": "Alert not found.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Acknowledged |
| 404 | Not your alert |

-   Acknowledgement is recorded per recipient on their delivery rows; other recipients still see the alert.

-   Acknowledging never cancels the lead's timers; only handling the lead does.

-   Allowed in every subscription state (control operation).

## API-038 Set notification preferences

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | PUT |
| Path | /api/v1/me/notification-preferences |
| Purpose | Choose alert channels and a personal quiet window. |
| Permission | Authenticated member |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | PUT replaces preferences. |
| Audit | member.notification_prefs_changed |
| Domain event | None. |
| Worker / async | None. |

Request example

    {
      "channels": {
        "in_app": true,
        "email": true,
        "sms": false
      },
      "escalations_always_email": true
    }

Success result (200)

    {
      "success": true,
      "message": "Preferences saved.",
      "data": {
        "channels": {
          "in_app": true,
          "email": true,
          "sms": false
        },
        "escalations_always_email": true,
        "sms_available": false
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (422)

    {
      "success": false,
      "error": {
        "code": "CHANNEL_NOT_AVAILABLE",
        "message": "Text-message alerts are not enabled for your organization yet.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Saved |
| 400 | Invalid channel |
| 422 | SMS not enabled for this organization |

-   In-app cannot be turned off for escalations; at least one channel stays active for managers.

# 26. Owner Dashboard Endpoint Contracts

## API-039 Owner dashboard summary

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/dashboard/summary |
| Purpose | Factual counts for a date range: leads, first-action time, overdue and outcomes. |
| Permission | dashboard.read |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | from, to (local dates), source_id (optional) |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "range": {
          "from": "2026-10-01",
          "to": "2026-10-14",
          "time_zone": "America/Chicago"
        },
        "leads": {
          "received": 52,
          "test_excluded": 1,
          "by_source": [
            {
              "source": "Website contact form",
              "count": 38
            },
            {
              "source": "Office phone line",
              "count": 11
            },
            {
              "source": "Manual entry",
              "count": 3
            }
          ]
        },
        "first_action": {
          "median_minutes": 11,
          "p90_minutes": 46,
          "within_target_pct": 79.0,
          "no_action_yet": 2
        },
        "unattended": {
          "overdue_now": 3,
          "unassigned_now": 2,
          "escalations_sent": 6
        },
        "outcomes": {
          "contacted": 31,
          "won": 9,
          "lost": 7,
          "spam": 2,
          "open": 3
        },
        "definitions": {
          "cohort": "leads created in range, excluding is_test, spam and merged",
          "first_action": "first call/text/email/visit activity (self-reported); notes and status changes excluded",
          "within_target_pct": "cohort leads whose first action was at or before due_at / cohort leads whose due_at has passed",
          "time_basis": "business minutes"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (403)

    {
      "success": false,
      "error": {
        "code": "AUTHORIZATION_DENIED",
        "message": "Only owners and managers can view the dashboard.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 400 | Range over 366 days |
| 403 | Not permitted |

-   No revenue, ROI or 'recovered' estimates are calculated or shown.

-   Business-hours-adjusted first-action time is labelled as such.

## API-040 Unresolved exceptions

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/dashboard/exceptions |
| Purpose | What a manager must fix: overdue/unassigned leads, failed alerts, failing sources, billing issues. |
| Permission | dashboard.read |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | cursor, limit |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "items": [
          {
            "type": "escalation_not_delivered",
            "lead_id": "019a2b90-99ae-7aca-87ef-56a19f56ae4f",
            "alert_id": "019a2bbf-8767-7494-8d64-200bf5ac1135",
            "text": "Escalation email to Chris Patel bounced (in-app delivered)",
            "since": "2026-10-14T15:00:30Z",
            "action": "Check Chris's email address"
          },
          {
            "type": "source_failing",
            "source_id": "019a2bff-3594-7d17-b29f-d05ed26570b5",
            "text": "Office phone line: 3 signature failures",
            "since": "2026-10-14T14:01:12Z",
            "action": "Rotate or re-enter the signing secret"
          },
          {
            "type": "lead_overdue",
            "lead_id": "019a2b90-99ae-7aca-87ef-56a19f56ae4f",
            "text": "Greg Hall overdue 72 min (Maria Lopez)",
            "since": "2026-10-14T14:30:00Z",
            "action": "Reassign or call"
          }
        ],
        "next_cursor": null
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (403)

    {
      "success": false,
      "error": {
        "code": "AUTHORIZATION_DENIED",
        "message": "Only owners and managers can view exceptions.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 403 | Not permitted |

-   Each exception has a concrete next action; resolved exceptions disappear automatically.

## API-041 Source health

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/dashboard/source-health |
| Purpose | Per-source delivery counts and silence detection for the last 7 days. |
| Permission | dashboard.read |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "items": [
          {
            "source_id": "019a2b21-2c94-7b5a-b86a-d61bf3ee110c",
            "name": "Website contact form",
            "status": "verified",
            "last_event_at": "2026-10-14T15:42:10Z",
            "last_7d": {
              "accepted": 31,
              "duplicate": 4,
              "rejected": 0
            },
            "silence_alert": false
          },
          {
            "source_id": "019a2bff-3594-7d17-b29f-d05ed26570b5",
            "name": "Office phone line",
            "status": "failing",
            "last_event_at": "2026-10-13T21:10:02Z",
            "last_7d": {
              "accepted": 11,
              "duplicate": 0,
              "rejected": 3
            },
            "silence_alert": false
          }
        ]
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (403)

    {
      "success": false,
      "error": {
        "code": "AUTHORIZATION_DENIED",
        "message": "Only owners and managers can view source health.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 403 | Not permitted |

-   Silence alert triggers when a verified source sends nothing for longer than its configured window (default 72 business hours).

# 27. Subscription and Billing Endpoint Contracts

## API-042 List plans

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/billing/plans |
| Purpose | Plain-language plan list with limits and prices. |
| Permission | Any member |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "currency": "USD",
        "status": "draft_pending_validation",
        "items": [
          {
            "plan_id": "starter",
            "name": "Starter",
            "price_monthly": null,
            "limits": {
              "members": 3,
              "sources": 1,
              "leads_per_month": 200
            }
          },
          {
            "plan_id": "team",
            "name": "Team",
            "price_monthly": null,
            "limits": {
              "members": 10,
              "sources": 3,
              "leads_per_month": 1000
            }
          }
        ],
        "note": "Prices are set by leadership within the USD 50-200 range before publication."
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (401)

    {
      "success": false,
      "error": {
        "code": "AUTHENTICATION_REQUIRED",
        "message": "Your session has expired. Sign in again.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 401 | Unauthenticated |

-   Prices come from configuration approved by leadership; this document does not set them.

-   While `status` is draft, the UI shows 'Contact us' instead of a price.

## API-043 Read subscription

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/billing/subscription |
| Purpose | Plan, trial or invoice state, usage against limits, cancellation and export options. |
| Permission | Any member (owners see payment details) |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "state": "trialing",
        "plan_id": "team",
        "trial": {
          "started_at": "2026-10-10T18:03:44Z",
          "ends_at": "2026-10-24T18:03:44Z",
          "card_on_file": false
        },
        "usage": {
          "members": 2,
          "sources": 2,
          "leads_this_month": 38
        },
        "writable": true,
        "after_trial": "Your account becomes read-only. You can export your data at any time.",
        "payment_method": null
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (401)

    {
      "success": false,
      "error": {
        "code": "AUTHENTICATION_REQUIRED",
        "message": "Your session has expired. Sign in again.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 401 | Unauthenticated |

-   `writable` is computed by the same entitlement guard used by write endpoints.

## API-044 Start checkout (explicit authorization)

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/billing/checkout |
| Purpose | Owner starts payment for a selected plan; returns the provider's hosted checkout URL. |
| Permission | billing.manage. INTEGRATION STATUS: BLOCKED until leadership selects the provider (INT-004) |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Idempotency-Key required; one open checkout per org. |
| Audit | billing.checkout_started |
| Domain event | billing.checkout_started |
| Worker / async | billing-reconcile. |

Request example

    {
      "plan_id": "team",
      "confirm_plan_and_price": true,
      "return_url": "https://app.leadguard.io/settings/billing"
    }

Success result (201)

    {
      "success": true,
      "message": "Continue on the secure payment page.",
      "data": {
        "checkout_id": "019a2b78-8014-7dd2-961b-5bed8986eaad",
        "provider": "selected_at_G0",
        "checkout_url": "https://checkout.provider.example/c/cs_7Hq2",
        "expires_at": "2026-10-14T16:12:11Z",
        "subscription_state": "trialing"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (409)

    {
      "success": false,
      "error": {
        "code": "BILLING_NOT_CONFIGURED",
        "message": "Online payment is not available yet. Contact us to arrange your plan.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 201 | Checkout created |
| 400 | Confirmation missing |
| 403 | Owner only |
| 409 | Checkout already open, or billing not configured (Release 1 default) |
| 503 | Billing provider unavailable |

-   No charge happens in this call. The subscription becomes `active` only after a verified provider webhook confirms payment.

-   Disabled until leadership selects the provider; the pilot uses the managed invoice path.

## API-045 Cancel subscription

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/billing/cancel |
| Purpose | Owner cancels; access continues to period end, then read-only with export. |
| Permission | billing.manage |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Idempotency-Key required. |
| Audit | billing.cancel_requested |
| Domain event | billing.cancel_requested |
| Worker / async | billing-reconcile. |

Request example

    {
      "reason": "Too expensive",
      "confirm": true
    }

Success result (200)

    {
      "success": true,
      "message": "Cancellation scheduled. You keep full access until Nov 10, 2026.",
      "data": {
        "state": "active",
        "cancel_at_period_end": true,
        "access_until": "2026-11-10T00:00:00Z",
        "then": "read_only",
        "export_available": true
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (400)

    {
      "success": false,
      "error": {
        "code": "CONFIRMATION_REQUIRED",
        "message": "Confirm that you want to cancel.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Scheduled |
| 400 | Confirmation missing |
| 403 | Owner only |
| 503 | Provider unavailable - cancellation queued |

-   Cancellation is never hidden behind support contact.

-   If the provider is down the request is stored and retried; the owner sees 'cancellation pending'.

## API-046 Billing provider webhook

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /webhooks/v1/billing/{provider} |
| Purpose | Receive subscription and payment events from the selected provider. |
| Permission | Provider signature verified by the billing adapter. INTEGRATION STATUS: BLOCKED until provider selection (INT-004) |
| Entitlement class | provider (Section 13.2) |
| Headers | Provider signature header, Content-Type |
| Path / query parameters | provider |
| Idempotency / concurrency | Unique provider event ID in `billing_events`. |
| Audit | billing.event_applied |
| Domain event | billing.subscription_changed |
| Worker / async | billing-reconcile on unknown ordering. |

Request example

    {
      "_note": "LeadGuard normalized billing event (test double); the real provider event is mapped by the adapter in INT-004.",
      "id": "evt_3Pq9",
      "type": "subscription.updated",
      "data": {
        "subscription_id": "sub_9Ka",
        "status": "active",
        "current_period_end": 1794268800,
        "metadata": {
          "org_id": "019a2b75-de36-7e2f-80ab-eb21aca45e7a"
        }
      }
    }

Success result (200)

    {
      "received": true,
      "applied": true,
      "org_state": "active"
    }

Duplicate provider event (200)

    {
      "received": true,
      "applied": false,
      "duplicate": true
    }

Error result (401)

    {
      "received": false,
      "error": "signature_invalid"
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Received |
| 400 | Unknown event type (stored, ignored) |
| 401 | Signature invalid |

-   The org is resolved from LeadGuard's stored provider customer ID, not from metadata alone.

-   Out-of-order events are resolved by fetching the subscription from the provider before applying.

## API-047 Notification delivery webhook

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /webhooks/v1/notifications/{provider} |
| Purpose | Receive email/SMS delivery, bounce and complaint events. |
| Permission | Provider signature. INTEGRATION STATUS: BLOCKED until the email provider is chosen (INT-003) |
| Entitlement class | provider (Section 13.2) |
| Headers | Provider signature header, Content-Type |
| Path / query parameters | provider |
| Idempotency / concurrency | Unique provider message event ID. |
| Audit | None (operational). |
| Domain event | alert.delivery_updated |
| Worker / async | None. |

Request example

    {
      "_note": "LeadGuard normalized delivery event (test double); provider payload and signature defined in INT-003 after provider selection.",
      "message_id": "msg_88ad",
      "event": "bounced",
      "at": "2026-10-14T15:00:30Z"
    }

Success result (200)

    {
      "received": true,
      "alert_id": "019a2bbf-8767-7494-8d64-200bf5ac1135",
      "channel": "email",
      "delivery_state": "failed"
    }

Error result (401)

    {
      "received": false,
      "error": "signature_invalid"
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Received |
| 401 | Signature invalid |

-   A bounce on an escalation creates a dashboard exception.

-   Delivered state never moves back to sent.

# 28. Export and Support Access Endpoint Contracts

## API-048 Request data export

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/exports |
| Purpose | Full CSV export of leads, activities and alerts; available in every subscription state. |
| Permission | exports.create (owner) |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Idempotency-Key required; one running export per org. |
| Audit | export.requested |
| Domain event | export.requested |
| Worker / async | export-builds. |

Request example

    {
      "include": [
        "leads",
        "activities",
        "alerts"
      ],
      "format": "csv_zip"
    }

Success result (202)

    {
      "success": true,
      "message": "Export started. We will email you when it is ready.",
      "data": {
        "export_id": "019a2bb8-4c28-78f7-b067-8782b92cec94",
        "status": "queued",
        "poll_url": "/api/v1/exports/019a2bb8-4c28-78f7-b067-8782b92cec94"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (409)

    {
      "success": false,
      "error": {
        "code": "EXPORT_IN_PROGRESS",
        "message": "An export is already running.",
        "retryable": false,
        "details": {
          "export_id": "019a2bea-25e2-7520-bad5-ef04eadd3ca7"
        }
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 202 | Queued |
| 403 | Owner only |
| 409 | Export already running |
| 429 | Max 5 exports per day |

-   CSV cells beginning with = + - @ are prefixed to prevent spreadsheet formula injection.

## API-049 Export status and download

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/exports/{exportId} |
| Purpose | Poll export status; returns a short-lived download URL when ready. |
| Permission | exports.create (owner) |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | exportId |
| Idempotency / concurrency | Read-only. |
| Audit | export.downloaded (when URL issued) |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "export_id": "019a2bb8-4c28-78f7-b067-8782b92cec94",
        "status": "ready",
        "rows": {
          "leads": 412,
          "activities": 1890,
          "alerts": 233
        },
        "download_url": "https://files.leadguard.io/exports/019a2bb8-4c28-78f7-b067-8782b92cec94.zip?sig=...",
        "url_expires_at": "2026-10-14T15:57:11Z",
        "file_expires_at": "2026-10-15T15:42:11Z"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (404)

    {
      "success": false,
      "error": {
        "code": "NOT_FOUND",
        "message": "Export not found or expired.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Status returned |
| 404 | Not found |

-   Signed URL valid 15 minutes; file deleted after 24 hours.

## API-050 List support access grants

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | GET |
| Path | /api/v1/support-access/grants |
| Purpose | Show the owner every past and current support access grant. |
| Permission | support.grant (owner) |
| Entitlement class | read (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID |
| Path / query parameters | None |
| Idempotency / concurrency | Read-only. |
| Audit | None. |
| Domain event | None. |
| Worker / async | None. |

Success result (200)

    {
      "success": true,
      "data": {
        "items": [
          {
            "grant_id": "019a2bb3-4e70-7a82-8665-fe27558df923",
            "scope": "read_only",
            "reason": "Ticket #1042 - missing leads from form",
            "granted_by": "Chris Patel",
            "starts_at": "2026-10-14T15:00:00Z",
            "expires_at": "2026-10-14T19:00:00Z",
            "status": "active",
            "accesses": 3
          }
        ]
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (403)

    {
      "success": false,
      "error": {
        "code": "AUTHORIZATION_DENIED",
        "message": "Only owners can manage support access.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Success |
| 403 | Owner only |

-   `accesses` counts support sessions under the grant; each is audited.

## API-051 Grant support access

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/support-access/grants |
| Purpose | Owner approves time-bound support access for a specific ticket. |
| Permission | support.grant (owner) |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | None |
| Idempotency / concurrency | Idempotency-Key required. |
| Audit | support.access_granted |
| Domain event | support.access_granted |
| Worker / async | Expiry job. |

Request example

    {
      "scope": "read_only",
      "duration_hours": 4,
      "reason": "Ticket #1042 - missing leads from form"
    }

Success result (201)

    {
      "success": true,
      "message": "Support can view your account (read-only) for 4 hours.",
      "data": {
        "grant_id": "019a2bb3-4e70-7a82-8665-fe27558df923",
        "scope": "read_only",
        "expires_at": "2026-10-14T19:42:11Z",
        "status": "active"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T15:42:11Z"
      }
    }

Error result (400)

    {
      "success": false,
      "error": {
        "code": "VALIDATION_FAILED",
        "message": "Support access can last at most 72 hours.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 201 | Granted |
| 400 | Duration over 72 hours |
| 403 | Owner only |

-   Scopes: read_only (default) or read_write; read_write requires a second confirmation.

-   Support staff are `users.kind = support_staff` accounts in a separate Clerk instance with MFA required. They call the same API with `X-Support-Grant-Id`; middleware checks `lg.active_support_grant()`, sets org context, forces read-only for `read_only` grants, and audits every request with the grant ID.

## API-052 Revoke support access

| Item | Contract |
|------------------------|--------------------------------------------------------|
| Method | POST |
| Path | /api/v1/support-access/grants/{grantId}/revoke |
| Purpose | End a support grant immediately. |
| Permission | support.grant (owner) |
| Entitlement class | control (Section 13.2) |
| Headers | Authorization, X-Org-Id (multi-org users), X-Request-ID, Idempotency-Key, Content-Type |
| Path / query parameters | grantId |
| Idempotency / concurrency | Idempotent. |
| Audit | support.access_revoked |
| Domain event | support.access_revoked |
| Worker / async | None. |

Request example

    {}

Success result (200)

    {
      "success": true,
      "message": "Support access revoked.",
      "data": {
        "grant_id": "019a2bb3-4e70-7a82-8665-fe27558df923",
        "status": "revoked",
        "revoked_at": "2026-10-14T16:05:00Z"
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2",
        "timestamp": "2026-10-14T16:05:01Z"
      }
    }

Error result (404)

    {
      "success": false,
      "error": {
        "code": "NOT_FOUND",
        "message": "Grant not found.",
        "retryable": false,
        "details": {}
      },
      "meta": {
        "api_version": "v1",
        "request_id": "req_01J9X4B7M2"
      }
    }

| HTTP | Meaning |
|------|------------------------------------------------|
| 200 | Revoked |
| 404 | Not found |

-   Active support sessions are terminated on the next request.

# 29. Frontend Architecture, Screens and Guided Setup

## 29.1 Frontend rules

-   Next.js 16.4.x App Router; server components render page shells; TanStack Query fetches live data from `/api/v1` with the Clerk session token. The frontend never talks to the database or providers.

-   Query keys always start with `['org', orgId, ...]`; switching organization or signing out clears the cache.

-   No lead data in `localStorage`, `sessionStorage`, analytics events or URLs. Lead UUIDs in URLs are allowed; names, phones and emails are not.

-   Actions disable while pending and reuse the same Idempotency-Key on retry. Status, assignment and billing never use optimistic updates; a pending save never looks complete.

-   Every screen has loading, empty, error, read-only (subscription `read_only`) and permission-denied states. A 409 `VERSION_CONFLICT` shows "Changed by someone else" with a Reload button; the user's unsaved input is kept.

-   Layout works from 360 px phones to office desktops; the inbox keeps the user's scroll position after an action.

-   WCAG 2.2 AA target: readable language, 4.5:1 contrast, full keyboard access, visible focus, meaningful empty states and clear error text.

## 29.2 Screens and API composition

| Screen | Operations | Important behavior |
|---|---|---|
| Guided setup | API-003, API-006, API-013, API-015, API-014 (poll every 3 s), API-008 | One step per screen; shows the exact failed verification step; never shows Connected before `verified` |
| Needs Action inbox | API-022, API-027, API-028 | Overdue, due soon and unassigned as separate groups, each with its own "load more"; log a call in a side sheet without leaving the list |
| Lead detail | API-025, API-026, API-028, API-029, API-030, API-031, API-032 | One primary action button from `primary_action`; due time in org time zone; timeline explains every reminder |
| All leads | API-023 | Filters; search text sent in the body |
| Alerts | API-036, API-037 | Badge count; acknowledging does not hide the lead from the inbox |
| Manager dashboard | API-039, API-040, API-041 | Factual counts with definitions shown on hover; each exception links to its fix |
| Team | API-007, API-008, API-010, API-011 | Role changes and deactivation with reassignment choice |
| Sources | API-012, API-014, API-016, API-017, API-018, API-019 | Delivery log with reason codes; disable and re-enable |
| Follow-up rules | API-033, API-034, API-035 | Preview shows due and escalation times before saving |
| Notification settings | API-038 | Channel choices |
| Subscription | API-042, API-043, API-044, API-045, API-048, API-049 | Plan limits, trial state, payment choice, cancellation and export in plain language; "Contact us" while billing is not configured |
| Support access | API-050, API-051, API-052 | Grant, view usage, revoke |

## 29.3 Guided setup flow

    Sign up (Clerk)
      -> Create organization: name, time zone, business hours            [API-003]   subscription = setup_pending
      -> Connect a source: "My form tool can sign webhooks"               [API-013]   auth_mode hmac_v1
                           "My form tool can add a header"                            auth_mode secret_header
                           "Add LeadGuard form code to my site"                       auth_mode embed
                           "Phone calls" (only when INT-002 is enabled)
      -> Copy endpoint + secret (shown once) or embed snippet
      -> Send a test enquiry: 15-minute window, live checklist           [API-015, API-014]
           endpoint reachable -> authentication valid -> fields mapped -> lead created
      -> Success: test lead shown in inbox (marked TEST); subscription = trialing
      -> Invite team (optional)                                          [API-008]
      -> Done: Needs Action inbox

::: callout-red
Setup honesty rule

If a verification step fails, the screen names that step and how to fix it (for example: "Signature did not match. Re-copy the signing secret into your form tool."). It never shows a green state, a spinner that implies success, or "Connected" before a real event has been processed.
:::

# 30. State Machines and Validation Rules

## 30.1 Lead status transitions (canonical)

| From | Allowed to | Actor | Precondition | Effect |
|---|---|---|---|---|
| new | attempted, contacted | Owner, manager, owner role | Usually via API-028 activity | Cancels first_response timer; may create follow_up timer |
| new | lost, spam | Owner, manager | `reason` required | Cancels all timers and pending deliveries |
| attempted | contacted, lost, spam | Owner, manager | `reason` for lost/spam | As above |
| contacted | qualified, won, lost | Owner, manager | `reason` for lost | Cancels timers |
| qualified | won, lost | Owner, manager | `reason` for lost | Cancels timers |
| won, lost, spam | attempted (reopen) | Manager or owner role only | `reason` required | New timer cycles; earlier alerts do not suppress new ones |
| any open | merged | Manager or owner role, via API-032 only | Survivor open and different | Terminal; `merged_into` set; timers cancelled |

`contacted` means a person was reached (outcome `reached` or `booked`). API-029 rejects other transitions with 422 `INVALID_TRANSITION` listing the allowed targets.

## 30.2 Other state machines

| Entity | Allowed state flow | Important guard |
|---|---|---|
| Source | draft -> testing -> verified <-> failing; any -> disabled -> testing (API-019) | `verified` only after a valid event in a verification window |
| Verification window | open -> passed / expired | One open window per source |
| Lead timer | pending -> claimed -> fired / cancelled; claimed -> pending (claim expired) | Fired only after recheck |
| Alert | open -> closed (all deliveries final) / cancelled (lead handled before sending) | One per timer occurrence |
| Alert delivery | pending -> sending -> accepted -> delivered / failed; sending -> unknown; pending -> cancelled | `unknown` is never resent automatically; delivered never moves back |
| Subscription | setup_pending -> trialing -> active / pilot_invoice / read_only; active -> past_due -> active / read_only; active (cancel_at_period_end) -> read_only; read_only -> active / pilot_invoice | Entitlement classes in Section 13.2 |
| Invitation | pending -> accepted / expired / revoked | Single-use token |
| Support grant | active -> expired / revoked | Max 72 hours (database CHECK) |
| Export | queued -> building -> ready -> expired; building -> failed | One running export per org (unique index) |

# 31. Domain Events

| Routing key | Minimum payload |
|---|---|
| lead.created | event_id, org_id, lead_id, source_id, owner_id, due_at |
| lead.repeat_enquiry | event_id, org_id, lead_id, source_event_id |
| lead.assigned | event_id, org_id, lead_id, owner_id, previous_owner_id |
| lead.activity_added | event_id, org_id, lead_id, activity_id, outcome |
| lead.status_changed | event_id, org_id, lead_id, from, to |
| lead.rescheduled | event_id, org_id, lead_id, due_at |
| lead.merged | event_id, org_id, lead_id, merged_lead_id |
| alert.requested / alert.delivery_updated | event_id, org_id, alert_id, delivery_id, state |
| source.created / source.verified / source.failing / source.disabled / source.enabled | event_id, org_id, source_id |
| billing.subscription_changed | event_id, org_id, from_state, to_state |
| member.invited / member.joined / member.role_changed / member.deactivated | event_id, org_id, user_id |
| support.access_granted / support.access_revoked | event_id, org_id, grant_id |

-   Events are written to `outbox_events` in the same transaction as the change and published after commit.

-   Payloads carry IDs and states only, never names, emails, phones or messages.

-   Consumers are idempotent by `event_id`; Release 1 consumers are internal workers only.

# 32. Audit, Privacy and PII-Safe Logging

| System | Allowed | Forbidden |
|---|---|---|
| Application logs | request_id, org_id, user_id, route template, status, duration, error code | Names, emails, phones, messages, tokens, secrets, raw webhook bodies |
| Error tracking | Stack traces with scrubbed request context | Request bodies, auth headers |
| Product analytics | Page names, feature clicks, counts | Any lead field; contact data in URLs or event properties |
| Queue payloads | IDs and states | Contact data |
| Audit events | Actor, action, record type and ID, changed field names, support grant ID | Before/after values of contact fields |
| Demos and screenshots | Synthetic data only | Real customer leads |

-   `audit_events` is insert-only for `lg_app` (DB-15); support access and exports are always audited.

-   Retention defaults are proposals for legal review (OD-04): leads and history while the subscription exists plus 90 days after it becomes read_only; delivery attempts 30 days; application logs 30 days; export files 24 hours.

# 33. N+1 Prevention, Indexing, Pagination and Caching

| Area | Required pattern | Forbidden pattern |
|---|---|---|
| Inbox | One query per section using `ix_leads_inbox`, with owner and source names joined | Loading owner or source per lead |
| Timeline | One UNION query over activities, alerts/deliveries and source events, ordered and paged | A request per item type |
| Dashboard | Aggregate SQL per metric with date-range filters | Loading all leads into memory |
| Timer firing | Batch claim with `FOR UPDATE SKIP LOCKED`, limit 100 (DB-10) | One scan per organization |
| Members list | Open-lead counts via grouped subquery | Count query per member |
| Redis cache | Plan limits and policy version, keyed by org and version, TTL 5 min | Caching leads or using cache for entitlement or write decisions |

Every list endpoint has an integration test asserting a fixed maximum number of SQL queries.

# 34. Observability, Metrics and Error Catalogue

## 34.1 Metrics (targets until measured)

| Metric | Target or alert |
|---|---|
| ingest_attempts_total{result} | Alert when rejected > 20% for a source over 1 hour |
| ingest_to_commit_latency_p95 | Target under 2 s |
| timer_fire_delay_p95 (due_at to fired) | Target under 60 s |
| alert_deliveries_total{state,channel} | Alert when failed + unknown > 5% over 1 hour |
| outbox_unpublished_age_seconds | Alert over 60 s |
| oldest_pending_timer_seconds | Alert over 5 minutes past due |
| sources_failing_total | Customer-facing problem count |
| api_responses_total{status} | Alert when 5xx > 1% for 5 minutes |
| readiness_state | Alert on `degraded` for more than 5 minutes |

## 34.2 Error catalogue (every code used in Sections 20-28)

| Error code | HTTP | Meaning |
|---|---|---|
| VALIDATION_FAILED | 400 | Field-level problems in `details.fields` |
| CONTACT_REQUIRED | 400 | Lead needs an email or phone |
| PAYLOAD_UNMAPPABLE | 400 | Adapter could not map a provider payload |
| CONFIRMATION_REQUIRED | 400 | Explicit confirmation flag missing |
| LOCAL_TIME_IN_DST_GAP | 400 | Local time does not exist (clocks move forward) |
| LOCAL_TIME_AMBIGUOUS | 400 | Local time occurs twice (clocks move back) |
| AUTHENTICATION_REQUIRED | 401 | Missing or expired session |
| SIGNATURE_INVALID | 401 | Ingest or webhook authentication failed |
| AUTHORIZATION_DENIED | 403 | Role does not allow the action |
| NOT_FOUND | 404 | Missing or outside the organization |
| VERSION_CONFLICT | 409 | Stale `expected_version` |
| IDEMPOTENCY_KEY_REUSED | 409 | Same key, different body |
| REQUEST_IN_PROGRESS | 409 | Same key still executing |
| ALREADY_CLAIMED | 409 | Another member claimed the lead |
| SOURCE_DISABLED | 409 (management API) / 410 (ingest) | Source turned off |
| SOURCE_NOT_VERIFIED | 409 | Event to a draft/testing source without an open window |
| EXPORT_IN_PROGRESS | 409 | An export is already running |
| BILLING_NOT_CONFIGURED | 409 | No billing provider configured (Release 1 default) |
| INVITATION_EXPIRED | 410 | Invitation no longer valid |
| INVALID_TRANSITION | 422 | Status change not allowed |
| PLAN_LIMIT_REACHED | 422 | Plan limit exceeded |
| ORG_LIMIT_REACHED | 422 | User already owns 3 organizations |
| LAST_OWNER | 422 | Would leave the organization without an owner |
| MERGE_NOT_ALLOWED | 422 | Invalid merge target |
| NOT_APPLICABLE | 422 | Operation does not apply to this source type |
| SOURCE_TYPE_NOT_ENABLED | 422 | Source type not enabled for this organization |
| CHANNEL_NOT_AVAILABLE | 422 | Notification channel not enabled |
| SUBSCRIPTION_INACTIVE | 423 | Operation not allowed in the current subscription state |
| RATE_LIMITED | 429 | Too many requests; `Retry-After` header set |
| BILLING_PROVIDER_UNAVAILABLE | 503 | Billing provider down; account unaffected |
| SERVICE_UNAVAILABLE | 503 | Temporary platform failure |

# 35. Configuration and Environment Variables

| Variable | Required | Meaning | How to obtain | Safe example |
|---|---|---|---|---|
| NODE_ENV | Yes | Runtime mode | Set by deploy | production |
| APP_URL / API_URL | Yes | Public origins | DNS owner | https://app.leadguard.io |
| DATABASE_URL | Yes | Runtime connection as `lg_app` (no BYPASSRLS) | Database admin creates role from `db/001_core_schema.sql` | postgres://lg_app:***@db:5432/leadguard |
| MIGRATION_DATABASE_URL | CI deploy step only | Connection as `lg_owner` | Database admin | postgres://lg_owner:***@db:5432/leadguard |
| SCANNER_DATABASE_URL | Worker | Connection as `lg_scanner` | Database admin | postgres://lg_scanner:***@db:5432/leadguard |
| REDIS_URL | Yes | BullMQ and rate limits | Managed Redis console | rediss://default:***@redis:6379 |
| CLERK_PUBLISHABLE_KEY | Yes | Clerk instance key (read by @clerk/fastify and @clerk/nextjs) | Clerk dashboard, API keys | pk_test_*** |
| CLERK_SECRET_KEY | Yes | Clerk backend secret | Clerk dashboard, API keys | sk_test_*** |
| CLERK_JWT_KEY | Optional | PEM public key for networkless token verification | Clerk dashboard, API keys | (PEM) |
| SUPPORT_CLERK_SECRET_KEY / SUPPORT_CLERK_PUBLISHABLE_KEY | Yes for support access | Separate Clerk instance for staff (MFA required) | Clerk dashboard | sk_test_*** |
| SOURCE_SECRET_ENCRYPTION_KEYS | Yes | Comma-separated 32-byte keys (newest first) for AES-256-GCM encryption of source secrets | Cloud secret manager | (base64) |
| EMAIL_PROVIDER | Yes | `none` until INT-003; then the adapter name | Product owner decision | none |
| EMAIL_PROVIDER_API_KEY | When EMAIL_PROVIDER set | Provider credential | Provider console | *** |
| EMAIL_FROM | Yes | Sender address on a verified domain | DNS owner + provider domain verification | LeadGuard <alerts@leadguard.io> |
| BOT_CHALLENGE_PROVIDER / BOT_CHALLENGE_SECRET | For embed sources | Server-side challenge verification (INT-005) | Provider console | none / *** |
| BILLING_PROVIDER | Yes | `none` until INT-004 | Leadership decision | none |
| BILLING_WEBHOOK_SECRET | When BILLING_PROVIDER set | Webhook verification secret | Provider console | *** |
| EXPORT_BUCKET | Yes | Private object storage bucket | Cloud console | leadguard-exports-prod |
| FEATURE_FLAGS | Yes | `call_sources`, `self_service_checkout`, `embed_sources`, `sms_alerts` | Config | call_sources:false,embed_sources:false |
| LOG_LEVEL | No | Logging level | Config | info |

Secrets live in the cloud secret manager; none are exposed to the browser except the Clerk publishable key.

# 36. Backend Layout, Deployment and Scaling

## 36.1 Pinned stack (DEC-002)

| Component | Version | Evidence |
|---|---|---|
| Node.js | 24 LTS (proposed) | EV-010 unverified in this audit - TASK-001 confirms on nodejs.org before pinning `.nvmrc` |
| fastify | 5.12.5 | EV-001 npm registry |
| @clerk/fastify | 3.1.88 (peer `fastify >=5`, engine `node >=20.9.0`) | EV-002 package inspected |
| @clerk/nextjs | 7.9.14 | EV-001 |
| next | 16.4.0 | EV-001 |
| zod | 4.6.5 | EV-001 |
| fastify-type-provider-zod | 7.0.0 (peer `zod >=4.1.5`, `fastify ^5.5.0`, `@fastify/swagger >=9.5.1`) | EV-003 package inspected |
| bullmq | 6.3.12 | EV-004 package inspected |
| pg | 8.x | EV-005 used by verify_db.mjs |
| luxon | 3.7.2 | EV-006 tests run |
| libphonenumber-js | 1.13.15 | EV-006 tests run |
| PostgreSQL | 17 (managed) | Schema verified on 16.13 (EV-007); re-run DB checks on 17 in TASK-002 |

Versions are the latest published at inspection (10 October 2026). TASK-001 commits a lockfile; later upgrades go through normal dependency review.

## 36.2 Repository layout (proposed paths)

    leadguard/
      apps/
        web/                  Next.js app
        api/                  Fastify server: routes -> services -> repositories
        worker/               BullMQ processors, outbox publisher, sweeper
      packages/
        domain/               business-time, ingest-signature, state machines, policy schema (pure TS)
        db/                   migrations (from db/001_core_schema.sql), repositories, set_config helper
        adapters/             email, bot-challenge, billing, call (interfaces + test doubles)
        contracts/            Zod schemas; OpenAPI generated via fastify-type-provider-zod + @fastify/swagger
      infra/                  container definitions, environment config, runbooks

-   Readiness (API-001): 200 when PostgreSQL is reachable (body `ready` or `degraded`), 503 only when it is not, so a Redis outage does not remove every API instance.

-   Deploy order: migrations (expand-only, as `lg_owner`) -> worker -> api; previous image retained for rollback; graceful shutdown waits up to 30 s for in-flight requests and releases timer claims.

-   Scale triggers (targets): API p95 over 500 ms or CPU over 70% sustained -> add an api container; timer fire delay p95 over 60 s -> add a worker.

-   Backups: managed point-in-time recovery (7 days minimum) and a monthly restore drill into a disposable database followed by `db/verify_db.mjs`.

# 37. Pilot Measurement and Commercial Proof

| Measure | Definition | Baseline | With LeadGuard |
|---|---|---|---|
| Unattended actionable leads | Cohort leads (Section 34 definitions: excluding test, spam, merged) with no contact attempt 24 business hours after creation | Customer records for 2-4 weeks before go-live, labelled customer-supplied | From `lead_activities` |
| Time to first action | Business minutes from creation to first call/text/email/visit activity (self-reported) | Sampled from customer records where timestamps exist | Median and p90 (API-039) |
| Overdue at close of business | Count of open leads past due at each day's closing time | Owner estimate, labelled estimate | Daily snapshot job writes `daily_metrics` at closing time (TASK-010) |
| Contact after escalation | Escalated leads with a `reached` activity within 2 business hours of escalation | Not available | From timeline data; describes what happened, not that the escalation caused it |

-   Customer-supplied baselines are never presented as LeadGuard measurements.

-   No testimonial, name, screenshot or result is used without written permission.

# 38. Testing Strategy and Release No-Go Gates

| Test layer | Required coverage |
|---|---|
| Unit | business-time (11 tests delivered), ingest-signature (6 tests delivered), state machines, dedupe key, phone normalization, policy schema |
| Database | `db/verify_db.mjs` (19 checks delivered) on the target PostgreSQL version |
| API contract | All 52 operations: headers, Zod validation, status codes, error codes, and responses matching `contracts/api-examples.json` |
| Ingest | Valid, forged, replayed, out-of-window, oversized, duplicate and concurrent deliveries for each auth mode |
| Rules and alerts | Timer fires once; cancellation on contact; policy change mid-flight; reopen creates new cycles; Redis loss and sweeper rebuild |
| Billing | Entitlement per class and state; webhook duplicates and ordering (with test double until INT-004) |
| Privacy | Automated scan of logs, error-tracker fixtures, analytics events and queue payloads for fixture contact data |
| End-to-end | Real form -> inbox -> claim -> call logged -> contacted; unattended lead -> reminder -> escalation; on mobile and desktop viewports |
| Usability | Five target users complete setup and daily work unaided |

## 38.1 Acceptance test register

| ID | Test | Pass condition |
|---|---|---|
| E2E-01 | Real enquiry from the pilot's verified source | Appears in the right org, gets owner and due time, can be actioned, escalates if left; mobile and desktop |
| UX-01 | Unaided setup | 4 of 5 target users finish setup without help |
| UX-02 | First-screen comprehension | Users name what needs action, its owner and next step within 10 seconds |
| SRC-01 | Valid hmac_v1 event | 201, one lead (unit part: SIG-01) |
| SRC-02 | Forged signature or wrong header secret | 401, no lead, attempt `rejected` (unit part: SIG-02, SIG-03) |
| SRC-03 | Unverified source display | Never shows Connected before a verified event |
| SRC-04 | Timestamp outside 300 s | 401 (unit part: SIG-04) |
| SRC-05 | Same event delivered 5 times concurrently | One lead, one set of timers, one source_event, five delivery attempts (database part: DB-08) |
| SRC-06 | Embed from non-allowed origin or failed challenge | 403, no lead |
| SRC-07 | Disabled source; re-enabled source | 410; after API-019 the source is `testing` |
| SRC-08 | Secret rotation | Old secret works 24 h, then 401 (unit part: SIG-05) |
| SRC-09 | Event to draft source without window | 409 `SOURCE_NOT_VERIFIED` |
| RUL-01..RUL-03 | Round-robin, fixed owner, unassigned queue, including no-eligible-member and inactive-owner cases | Section 11.2 table |
| RUL-04 | Business-time cases | 11 unit tests (RUL-04a..k) pass |
| RUL-05..RUL-08 | Follow-up cadence, max attempts, policy version change, snooze | Expected timers only |
| ALR-01 | Overdue lead | One reminder alert with one delivery per enabled channel |
| ALR-02 | Still overdue after delay | One escalation; recipients per Section 11.2 |
| ALR-03 | Timer job replayed | No second alert (database part: DB-11) |
| ALR-04 | Lead contacted before timer fires | Alert cancelled, timeline explains |
| ALR-05 | Email provider timeout after send | Delivery `unknown`, no automatic resend |
| ALR-06 | Lead reopened | New timer cycle produces a new alert (DB-11 second half) |
| AUD-01 | Every write | Audit row with actor and request ID |
| AUD-02 | Timeline | Each reminder/escalation names timer kind, cycle and policy version |
| SEC-01..SEC-06 | Cross-org ID access, list, search, export, worker, cursor | 404 / empty; zero leakage (database part: DB-02..DB-07) |
| SEC-07 | Support access without grant, after expiry, after revoke | Denied and audited |
| PRV-01..PRV-04 | Logs, errors, analytics, queues | No fixture contact data found |
| REC-01..REC-05 | Source down, email down, billing down, Redis restart, worker crash | Safe state shown; recovery without data loss |
| BIL-01 | Subscription screen | Limits, trial, cancellation and export shown in plain language |
| BIL-02 | Checkout without explicit confirmation | Rejected; no provider call |
| BIL-03 | Duplicate billing webhook | Applied once |
| BIL-04 | business_write, setup or ingest while read_only | 423, nothing written; control operations and export still work |
| BIL-05 | Cancel | Access until period end, then read_only |
| BIL-06 | Setup while setup_pending | Setup operations allowed; business_write rejected; verification event starts trial |
| PIL-01 | Pilot metrics | Baseline and after figures recorded with their sources |

::: callout-red
Release no-go

Do not release if another organization can access a lead, a forged signed event creates a lead, a replayed event creates a duplicate lead or alert, a read_only subscription accepts business writes or ingest, a payment can be taken without explicit authorization, or a source can show Connected without a verified event. A polished interface cannot compensate for an unreliable workflow.
:::

# 39. Implementation Order

The build order is the task list in Appendix F. TASK-001 to TASK-013 are ready to implement; TASK-014 to TASK-016 are BLOCKED by owner decisions or provider selection; TASK-017 (hardening and pilot go-live) needs TASK-014 because pilot alerts require email.

# 40. Release 1 Definition of Done

☐ A real enquiry from the pilot's verified source reaches the correct organization, gets an owner and due time, is actioned, and produces the right manager alert when left unresolved.

☐ The owner can read the lead timeline and understand why each reminder and escalation happened without an engineer.

☐ The same flow passes on a phone and on a desktop.

☐ All 52 operations return responses matching `contracts/api-examples.json` in shape, status codes and error codes.

☐ `db/verify_db.mjs`, business-time and ingest-signature tests pass on the target versions.

☐ Forged, replayed and duplicate events never create a second lead or alert.

☐ Pending alerts are cancelled when the lead is already handled.

☐ Every tenant table has FORCE RLS; cross-organization tests pass with zero leakage.

☐ Support access only works through an owner grant and is fully audited.

☐ read_only subscriptions reject business writes, setup and ingest; control operations and export work.

☐ No payment path exists without explicit owner confirmation and a verified provider event.

☐ Logs, analytics, error tracking and queue payloads are proven free of contact data.

☐ Source, email, billing and Redis failures show a safe state and recover without data loss.

☐ Runbooks exist for: source failing, alerts not delivered, timer backlog, billing webhook failure, suspected cross-org access.

☐ Pilot baseline is recorded before go-live.

# Appendix A - Release 1 API Count by Domain

| Domain | HTTP operations |
|---|---|
| System and organization | 6 |
| Team and invitations | 5 |
| Sources | 8 |
| Ingestion (public) | 2 |
| Inbox and leads | 11 |
| Rules and alerts | 6 |
| Owner dashboard | 3 |
| Subscription and billing (incl. provider webhooks) | 6 |
| Export and support access | 5 |
| **TOTAL** | **52** |

The count is computed from the registry by the verification script (CHK-03). Routes are grouped into the modules in Section 36.2, not one service per route.

# Appendix B - Release 2 Handoff (Not Implemented in This Document)

-   Self-service checkout on the provider selected by leadership, with published prices.

-   Additional verified sources chosen from real customer demand, one at a time.

-   Staff SMS alerts and PWA push notifications.

-   Usage-based plan limits and in-app upgrade prompts.

-   Optional export of closed leads into the customer's CRM.

-   Native mobile apps only if responsive web use proves insufficient.

# Appendix C - Engineering No-Omission Checklist

☐ Pilot form tool and auth mode confirmed from a real customer before connector work (OD-01).

☐ Every effectful endpoint uses Idempotency-Key and/or expected_version (R-IDEM-1..4).

☐ `source_events (source_id, dedupe_key)` and `alerts (timer_id)` unique indexes exist; `delivery_attempts` and `alert_deliveries` are separate repeatable rows.

☐ Timer and alert decisions are stored in PostgreSQL; Redis loss is tested.

☐ Workers recheck lead state before every side effect.

☐ Due times use `addBusinessMinutes`; snooze uses `parseLocalWallTime`.

☐ Entitlement class checked inside the write transaction.

☐ Bootstrap lookups are the only pre-context database access.

☐ No contact data in URLs, logs, analytics or queues.

☐ Every endpoint's live responses match `contracts/api-examples.json`.

☐ Delivery states never claim delivery the provider did not confirm.

☐ Support grants expire automatically and are audited.

☐ Export files and signed URLs expire.

☐ Release no-go checklist signed by engineering, QA, product and leadership.

# Appendix D - Decision Register and Open Owner Decisions

## D.1 Decisions

| ID | Decision | Classification | Rationale | Reversal impact |
|---|---|---|---|---|
| DEC-001 | Next.js frontend, Node.js + TypeScript + Fastify modular monolith, PostgreSQL, Redis/BullMQ | Supplied (Hamza, stack choice for this spec) | Matches the team's MedSynthea stack | High after TASK-003 |
| DEC-002 | Pinned versions in Section 36.1 | Proposed | Latest published versions at inspection; Node 24 LTS unconfirmed (EV-010) | Low before TASK-001 |
| DEC-003 | UUIDv7 primary keys used directly as API IDs; no prefixed public IDs | Proposed (changed from v1.0) | v1.0 examples used prefixed IDs that did not match the uuid schema | Medium after TASK-002 |
| DEC-004 | One alert per timer occurrence; one delivery row per recipient and channel | Proposed (changed from v1.0) | v1.0 key suppressed repeated cycles and could not track several managers | Medium |
| DEC-005 | Entitlement classes (Section 13.2) | Proposed (changed from v1.0) | v1.0 blanket write guard made setup and recovery impossible | Low |
| DEC-006 | Ingest auth modes hmac_v1, secret_header, embed | Proposed | Many form tools cannot compute HMAC signatures; the mode is chosen per source | Low |
| DEC-007 | Provider-neutral call adapter; provider chosen with the pilot | Supplied (Hamza) and CEO direction | No connector for an imagined account | n/a |
| DEC-008 | Readiness 503 only when PostgreSQL is down | Proposed (changed from v1.0) | v1.0 503-on-Redis would remove all API instances during a Redis outage | Low |
| DEC-009 | Support staff in a separate Clerk instance acting through `X-Support-Grant-Id` | Proposed | Keeps staff identities apart from customers; every action audited under a grant | Medium |
| DEC-010 | Ingest returns 201 for a new lead and 200 for linked, logged or duplicate | Proposed (changed from v1.0 202) | The lead is committed before the response, so 202 was inaccurate | Low |

## D.2 Open owner decisions

| ID | Decision needed | Owner | Default until decided | Blocks |
|---|---|---|---|---|
| OD-01 | Pilot customer, their form tool, its auth capability, and whether they use a call source | Product and commercial | Build hmac_v1 and secret_header modes; no call adapter | TASK-015 (embed), TASK-016 (call); final pilot mapping in TASK-008 |
| OD-02 | Ingest while read_only: reject (current) or hold events for reactivation | Product owner | Reject with 423, log attempt, show owner banner | None (behaviour change is contained in the entitlement guard) |
| OD-03 | Trial length, plan limits and prices (USD 50-200 range) | Leadership | 14-day trial and illustrative limits in configuration; prices hidden ("Contact us") | Publication, TASK-016 |
| OD-04 | Customer terms and data retention | Business and legal owners | Section 32 proposals; no scale onboarding | Onboarding beyond the pilot |
| OD-05 | Payment provider and contracting entity | Finance and leadership | `BILLING_PROVIDER=none`; pilot by invoice | TASK-016 |
| OD-06 | Email provider for alerts and invitations | Engineering lead with finance approval | In-app alerts only; invitation links copied manually | TASK-014 and TASK-017 (pilot go-live) |

# Appendix E - Integration Register

| ID | Integration | Status | What is verified | What remains |
|---|---|---|---|---|
| INT-001 | Clerk (customer and support instances) | READY TO IMPLEMENT | Package exports `clerkPlugin`, `getAuth`, `verifyToken`, `clerkClient`; env names `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, optional `CLERK_JWT_KEY`; `sessions.revokeSession` exists (EV-002) | Sandbox sign-in test in TASK-003; Clerk documentation pages were not opened in this audit (fetch permission not granted) |
| INT-006 | Website form webhook (hmac_v1, secret_header) | READY TO IMPLEMENT | LeadGuard-defined contract; reference verifier tested (SIG-01..06) | Mapping for the pilot's actual form tool (OD-01) |
| INT-005 | Bot challenge for embed sources | BLOCKED | Nothing - provider not chosen | Provider selection, server verification contract, sandbox test; embed stays feature-flagged off |
| INT-003 | Email provider (alerts, invitations, delivery webhooks) | BLOCKED | Adapter interface and delivery-state model (Section 12) | Provider selection (OD-06), send API, idempotency support, webhook signature, bounce events, sandbox test |
| INT-002 | Call provider | BLOCKED | Normalized call event (API-021) | Provider selection (OD-01), payload mapping, signature, sandbox call test |
| INT-004 | Billing provider | BLOCKED | Adapter interface, entitlement model, normalized event (API-046) | Provider and entity selection (OD-05), checkout, webhooks, reconciliation, sandbox test |

A blocked integration is replaced by a labelled test double in automated tests only. No environment may report a blocked provider as connected, and no code path may fake a successful send or payment.

# Appendix F - Build Tasks

Paths are proposed until the repository exists. Each task ends with the evidence listed under "Done when".

### TASK-001 Repository, toolchain and version pins

-   **Why:** Every later task needs one reproducible workspace.
-   **Depends on:** none. Owner prerequisite: Git hosting and a CI runner.
-   **Read:** Sections 5, 36; Appendix D (DEC-001, DEC-002).
-   **Change:** create `leadguard/` with `apps/web`, `apps/api`, `apps/worker`, `packages/domain`, `packages/db`, `packages/adapters`, `packages/contracts`; `.nvmrc`; `pnpm-workspace.yaml`; root `package.json`; CI workflow.
-   **Implement:** 1) Confirm the current Node.js LTS line on nodejs.org/en/about/previous-releases and pin it in `.nvmrc` (expected 24; record the page and date). 2) Use pnpm workspaces. 3) Add the exact versions from Section 36.1 and commit `pnpm-lock.yaml`. 4) CI runs `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test`.
-   **Run:** `corepack enable && pnpm install && pnpm -r typecheck` in `leadguard/`.
-   **Expect:** install succeeds with no peer-dependency errors for @clerk/fastify (peer fastify >=5) and fastify-type-provider-zod (peer zod >=4.1.5, fastify ^5.5.0, @fastify/swagger >=9.5.1).
-   **Failure checks:** peer warnings mean a version drifted - re-pin to Section 36.1.
-   **Troubleshoot:** "Unsupported engine" -> Node version below the package `engines`; switch with the version manager.
-   **Done when:** lockfile committed; CI green on an empty test suite; Node LTS evidence recorded.

### TASK-002 Database schema, roles and isolation checks

-   **Why:** Tenant isolation and dedupe must be enforced by the database before any API code.
-   **Depends on:** TASK-001; owner prerequisite: a disposable PostgreSQL 17 database.
-   **Read:** Sections 14, 15; `db/001_core_schema.sql`; `db/verify_db.mjs`.
-   **Change:** `packages/db/migrations/001_core_schema.sql` (copy unchanged), `packages/db/test/verify_db.mjs`.
-   **Implement:** 1) Apply the migration as an admin role (it creates roles, then switches to `lg_owner`). 2) Set passwords for `lg_owner`, `lg_app`, `lg_scanner` outside the migration. 3) Run the verification suite.
-   **Run:** `psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/migrations/001_core_schema.sql` then `PGHOST=... PGPORT=... PGDATABASE=... node packages/db/test/verify_db.mjs`.
-   **Expect:** 19 rows, all PASS (the audit run on PostgreSQL 16.13 produced exactly this).
-   **Failure checks:** DB-17 fails if a runtime role was created with BYPASSRLS; DB-18 fails if tables were created as the admin role.
-   **Troubleshoot:** "must be owner of function" -> the migration must run with an admin able to `GRANT lg_lookup TO lg_owner`; managed services may require running the role block as the cloud admin user.
-   **Done when:** suite output saved to `docs/evidence/TASK-002.md` with PostgreSQL version.

### TASK-003 Authentication, bootstrap and organization creation (API-001, API-002, API-003)

-   **Why:** A new user must reach an organization before any org-scoped query can run.
-   **Depends on:** TASK-002; owner prerequisite: Clerk development instance keys (INT-001).
-   **Read:** Sections 7, 15.2, 16; API-001..003.
-   **Change:** `apps/api/src/plugins/auth.ts`, `apps/api/src/db/withOrg.ts`, routes for API-001..003.
-   **Implement:** 1) Register `clerkPlugin`; in a preHandler call `getAuth(request)`; reject with 401 when no `userId`. 2) `lg.upsert_user()` on each request (cache by user ID for 60 s). 3) `withOrg(orgId, userId, fn)` opens a transaction and runs `SELECT set_config('app.org_id',$1,true), set_config('app.user_id',$2,true)`. 4) API-003 calls `lg.bootstrap_organization()` and creates policy v1 and business hours v1 in the new org context. 5) API-001 readiness per Section 36.2.
-   **Run:** `pnpm --filter api test` with a Clerk test user token.
-   **Expect:** API-002 for a new user returns `organizations: []`; after API-003 it returns the org with role owner and `subscription_state: setup_pending`.
-   **Failure checks:** missing token -> 401; fourth owned org -> 422 `ORG_LIMIT_REACHED`; Redis stopped -> API-001 200 `degraded`.
-   **Troubleshoot:** all queries return empty -> context not set in the same transaction as the query.
-   **Done when:** responses match `contracts/api-examples.json` for API-001..003.

### TASK-004 Shared API plumbing: envelopes, errors, idempotency, entitlement

-   **Why:** Every endpoint depends on the same envelope, error and duplicate-effect rules.
-   **Depends on:** TASK-003.
-   **Read:** Sections 13.2, 16, 18, 34.2.
-   **Change:** `apps/api/src/plugins/{envelope,errors,idempotency,entitlement}.ts`, `packages/contracts/src/errors.ts`.
-   **Implement:** 1) Envelope and error codes exactly as Section 34.2. 2) Idempotency per R-IDEM-1..4 using `idempotency_keys`. 3) `assertEntitled(class)` reading `subscriptions` inside the request transaction. 4) Route option `entitlement` required on every route (startup fails if missing).
-   **Run:** `pnpm --filter api test -- idempotency entitlement`.
-   **Expect:** same key + same body returns the stored response; same key + different body 409 `IDEMPOTENCY_KEY_REUSED`; business_write in setup_pending 423.
-   **Failure checks:** concurrent duplicate requests -> one executes, the other 409 `REQUEST_IN_PROGRESS`.
-   **Troubleshoot:** replay returns a secret -> R-IDEM-3 redaction missing.
-   **Done when:** unit tests for every row of the Section 13.2 table pass.

### TASK-005 Organization settings, team and invitations (API-004..API-011)

-   **Why:** Owners configure hours and invite the team.
-   **Depends on:** TASK-004.
-   **Read:** Section 7; API-004..011.
-   **Change:** `apps/api/src/modules/org/*`, `apps/api/src/modules/team/*`.
-   **Implement:** contracts as written; invitation token 32 random bytes, stored as SHA-256; acceptance via `lg.resolve_invitation()`; the invitation email is an alert-delivery row of kind invitation (sent once INT-003 exists; until then the UI shows a copyable link).
-   **Run:** `pnpm --filter api test -- org team`.
-   **Expect:** responses match the examples; last-owner protection; deactivation reassigns leads in one transaction.
-   **Failure checks:** manager inviting an owner -> 403; expired token -> 410.
-   **Troubleshoot:** accepted invitation not visible -> membership inserted without org context.
-   **Done when:** contract tests for API-004..011 pass.

### TASK-006 Domain library

-   **Why:** Time, signature, transitions and policy rules must have one tested implementation.
-   **Depends on:** TASK-001.
-   **Read:** Sections 9.4, 11, 30.1; `domain/business-time.mjs`, `domain/ingest-signature.mjs` and their tests.
-   **Change:** `packages/domain/src/{business-time,ingest-signature,lead-transitions,policy-schema}.ts` (port the delivered modules to TypeScript without changing behavior) and tests.
-   **Implement:** port both modules; encode Section 30.1 as a transition table; express Section 11.1 bounds as a strict Zod schema.
-   **Run:** `pnpm --filter domain test`.
-   **Expect:** the 17 delivered tests pass after porting, plus one test per transition-table row.
-   **Failure checks:** DST cases RUL-04f/j/k.
-   **Troubleshoot:** gap times not rejected -> `parseLocalWallTime` comparison removed.
-   **Done when:** coverage report shows every transition row tested.

### TASK-007 Sources and verification (API-012..API-019)

-   **Why:** A source must be proven before it shows Connected.
-   **Depends on:** TASK-004, TASK-006.
-   **Read:** Section 9; API-012..019.
-   **Change:** `apps/api/src/modules/sources/*`.
-   **Implement:** create with `source_key` (random, 24 base62 characters), secret 32 random bytes encrypted with AES-256-GCM using `SOURCE_SECRET_ENCRYPTION_KEYS`; verification windows; rotate keeps previous secret 24 h; disable/enable state rules.
-   **Run:** `pnpm --filter api test -- sources`.
-   **Expect:** status never becomes `verified` without an event inside a window; API-013 replay omits the secret.
-   **Failure checks:** second open window returns the existing one.
-   **Troubleshoot:** secret unreadable after deploy -> encryption key order changed; keys are newest first.
-   **Done when:** contract tests pass.

### TASK-008 Form ingest (API-020)

-   **Why:** Real enquiries become leads exactly once.
-   **Depends on:** TASK-007.
-   **Read:** Sections 9, 10; API-020.
-   **Change:** `apps/api/src/modules/ingest/forms.ts` with raw-body capture (`addContentTypeParser` returning the Buffer, parsed after verification).
-   **Implement:** pipeline in Section 10 exactly; matching rules; delivery attempts for every request.
-   **Run:** `pnpm --filter api test -- ingest` including 5 concurrent identical deliveries.
-   **Expect:** SRC-01, 02, 04, 05, 07, 08, 09 pass.
-   **Failure checks:** signature computed on parsed JSON instead of raw bytes fails SIG-03.
-   **Troubleshoot:** duplicates created under load -> insert not using `ON CONFLICT (source_id, dedupe_key)`.
-   **Done when:** tests pass and the pilot form tool mapping is recorded once OD-01 is answered.

### TASK-009 Leads (API-022..API-032)

-   **Why:** The team acts on leads from the inbox.
-   **Depends on:** TASK-008.
-   **Read:** Sections 11.2, 30.1, 33; API-022..032.
-   **Change:** `apps/api/src/modules/leads/*`.
-   **Implement:** contracts as written; guarded updates with `version`; timers created or cancelled in the same transaction as the lead change.
-   **Run:** `pnpm --filter api test -- leads` with the N+1 query-count assertions.
-   **Expect:** responses match the examples; two concurrent claims -> one 200, one 409 `ALREADY_CLAIMED`.
-   **Failure checks:** member reading another member's lead -> 404.
-   **Troubleshoot:** inbox counts differ from lists -> counts and sections must use the same predicates.
-   **Done when:** contract and query-count tests pass.

### TASK-010 Rules, timers, alerts and daily metrics (API-033..API-038)

-   **Why:** Neglected leads trigger reminders and escalations.
-   **Depends on:** TASK-009.
-   **Read:** Sections 11, 12, 17, 37.
-   **Change:** `apps/worker/src/{sweeper,timers,alerts,outbox,dailyMetrics}.ts`, `apps/api/src/modules/rules/*`.
-   **Implement:** sweeper as `lg_scanner` (Section 12.1); per-timer processing as `lg_app`; in-app delivery channel; email channel behind the adapter interface (test double until INT-003); daily metrics at each org's closing time.
-   **Run:** `pnpm --filter worker test` with a fake clock; kill the worker mid-batch and restart.
-   **Expect:** ALR-01..06 pass; no duplicate alert after restart.
-   **Failure checks:** Redis flushed -> sweeper rebuilds wake-ups within 60 s.
-   **Troubleshoot:** timers never fire -> scanner policy or column grants missing (DB-09).
-   **Done when:** tests pass and fire-delay metric is emitted.

### TASK-011 Dashboard (API-039..API-041)

-   **Why:** Owners see factual counts and what to fix.
-   **Depends on:** TASK-010.
-   **Read:** Sections 33, 37; API-039..041.
-   **Change:** `apps/api/src/modules/dashboard/*`.
-   **Implement:** aggregate SQL using the definitions in the API-039 example.
-   **Run:** `pnpm --filter api test -- dashboard` with the fixture.
-   **Expect:** totals equal hand-computed fixture values.
-   **Failure checks:** test leads excluded; spam and merged excluded.
-   **Troubleshoot:** p90 wrong -> use `percentile_cont(0.9)` over business minutes.
-   **Done when:** fixture-based tests pass.

### TASK-012 Subscription state, export and support access (API-042, 043, 045, 048..052)

-   **Why:** Read-only enforcement, cancellation, export and audited support are release blockers.
-   **Depends on:** TASK-004, TASK-009.
-   **Read:** Section 13; API-042..052.
-   **Change:** `apps/api/src/modules/{billing,exports,support}/*`, `apps/worker/src/{billingReconcile,exports}.ts`, operator CLI `scripts/set-pilot-invoice.ts`.
-   **Implement:** state transitions without a provider; API-044 returns 409 `BILLING_NOT_CONFIGURED` while `BILLING_PROVIDER=none`; CSV export with formula-injection guard; support middleware for `X-Support-Grant-Id`.
-   **Run:** `pnpm --filter api test -- billing exports support`.
-   **Expect:** BIL-01, 04, 05, 06 and SEC-07 pass.
-   **Failure checks:** export allowed in read_only; business_write rejected.
-   **Troubleshoot:** export stuck `queued` -> sweeper re-enqueue missing.
-   **Done when:** tests pass.

### TASK-013 Web application screens

-   **Why:** Users complete setup and daily work on phone and desktop.
-   **Depends on:** TASK-003..TASK-012 APIs for each screen.
-   **Read:** Section 29; screen table.
-   **Change:** `apps/web/app/*`.
-   **Implement:** screens in Section 29.2 with every state in Section 29.1; Playwright tests at 360 px and 1280 px.
-   **Run:** `pnpm --filter web test:e2e`.
-   **Expect:** E2E-01 passes against a local stack with a signed test webhook.
-   **Failure checks:** Connected never shown for draft/testing/failing.
-   **Troubleshoot:** stale data after org switch -> query cache not cleared.
-   **Done when:** e2e and axe accessibility checks pass.

### TASK-014 Email adapter (INT-003) - BLOCKED by OD-06

-   **Depends on:** provider selection and sandbox account. Then implement send, delivery webhook (API-047) and reconciliation using only that provider's documentation; run ALR-05 against the sandbox.

### TASK-015 Embed sources and bot challenge (INT-005) - BLOCKED by OD-01 and provider selection

-   **Depends on:** pilot need confirmed. Then implement origin allowlist, challenge verification and rate limits; keep `embed_sources` flag off until SRC-06 passes.

### TASK-016 Call adapter (INT-002) and billing provider (INT-004) - BLOCKED by OD-01 and OD-05

-   **Depends on:** provider selections. Each adapter maps the provider's documented payloads to API-021 / API-046 normalized events and passes sandbox tests before its feature flag is enabled.

### TASK-017 Hardening and pilot go-live

-   **Depends on:** TASK-013 and TASK-014.
-   **Implement:** privacy scans (PRV-01..04), recovery drills (REC-01..05), load test to the Section 34.1 targets, restore drill, usability test (UX-01, UX-02), baseline capture (PIL-01), then enable the pilot organization.
-   **Done when:** Release no-go list cleared and signed.

# Appendix G - Coding-Agent Handoff

Use this instruction with any AI coding tool:

> Read the repository instructions, this specification (LeadGuard Release 1 Implementation Specification v1.1), `db/001_core_schema.sql`, `contracts/api-examples.json`, the delivered `domain/` modules, and TASK-[ID] in Appendix F. Inspect existing code and installed dependency versions. Implement only this task and preserve unrelated changes. Follow the specified business rules and interfaces. If required information is missing or sources conflict, identify the exact conflict and complete independent work; do not invent an API, provider capability, or passing result. Never replace a blocked integration with a fake success. Run the task's checks where supported. Report changed files, commands run, observed results, unrun checks with reasons, migrations, blockers, and the next dependency-safe task.

Continuation record (update after every task):

| Field | Value at v1.1 |
|---|---|
| Specification revision | LG-R1-IMPL-1.1.0 |
| Completed tasks | None (repository not created) |
| Delivered verified artifacts | db/001_core_schema.sql, db/verify_db.mjs, domain/business-time.mjs (+tests), domain/ingest-signature.mjs (+tests), contracts/api-examples.json |
| Next task | TASK-001 |
| Open decisions | OD-01..OD-06 |
| Blocked integrations | INT-002, INT-003, INT-004, INT-005 |

# Appendix H - Evidence Ledger and Verification Report

## H.1 Evidence

| ID | Claim supported | Source | Version / environment | Inspected | Level |
|---|---|---|---|---|---|
| EV-001 | Latest published versions: fastify 5.12.5, next 16.4.0, zod 4.6.5, @clerk/fastify 3.1.88, @clerk/nextjs 7.9.14, bullmq 6.3.12, luxon 3.7.2, libphonenumber-js 1.13.15, fastify-type-provider-zod 7.0.0 | npm registry (`npm view <pkg> version`) | registry.npmjs.org | 10 Oct 2026 | Locally checked |
| EV-002 | @clerk/fastify exports clerkPlugin, getAuth, verifyToken, clerkClient, createClerkClient; peer fastify >=5; engine node >=20.9.0; env names CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, CLERK_JWT_KEY; SessionApi.revokeSession exists | Installed package files `node_modules/@clerk/fastify`, `@clerk/backend/dist/api/endpoints/SessionApi.d.ts` | @clerk/fastify 3.1.88 | 10 Oct 2026 | Locally checked (not sandbox tested) |
| EV-003 | fastify-type-provider-zod peers: @fastify/swagger >=9.5.1, fastify ^5.5.0, zod >=4.1.5 | Installed package.json | 7.0.0 | 10 Oct 2026 | Locally checked |
| EV-004 | BullMQ: `delay` and `jobId` options; duplicate jobId not added; custom IDs cannot be integers or contain ':'; queue names cannot contain ':' | Installed `dist/esm/interfaces/base-job-options.d.ts`, `dist/cjs/classes/job.js`, `queue-base.js` | bullmq 6.3.12 (also present in 5.81.5) | 10 Oct 2026 | Locally checked |
| EV-005 | PostgreSQL: `SET LOCAL x = $1` with a bind parameter is a syntax error; `set_config(..., true)` works and does not leak across pooled transactions | DB-01, DB-05 executed | PostgreSQL 16.13, node-postgres 8 | 10 Oct 2026 | Locally tested |
| EV-006 | Luxon shifts DST-gap local times forward silently and picks one offset for repeated times; guard required | Node script and RUL-04j/k | luxon 3.7.2, Node 22.22.2 | 10 Oct 2026 | Locally tested |
| EV-007 | Canonical schema applies cleanly; RLS, scanner policy, bootstrap functions, dedupe and alert keys behave as specified | `db/verify_db.mjs` 19/19 PASS | PostgreSQL 16.13 | 10 Oct 2026 | Locally tested |
| EV-008 | Business-time calculator results used in examples | `domain/business-time.test.mjs` 11/11 PASS | Node 22.22.2 | 10 Oct 2026 | Locally tested |
| EV-009 | hmac_v1 verifier behaviour | `domain/ingest-signature.test.mjs` 6/6 PASS | Node 22.22.2 | 10 Oct 2026 | Locally tested |
| EV-010 | Node.js 24 is the current Active LTS line | Not inspected - nodejs.org fetch permission not granted during the audit | n/a | n/a | Unknown (TASK-001 verifies) |
| EV-011 | CEO requirements, open decisions and release blockers | LeadGuard CEO Project Direction (supplied .docx) | Supplied document | 10 Oct 2026 | Supplied |

## H.2 Checks run

| Check | Behavior | Method | Result | Limitation |
|---|---|---|---|---|
| DB-01..DB-19 | Isolation, bootstrap, dedupe, scanner, claims, alerts, constraints, roles | `node db/verify_db.mjs` on a disposable database | PASS (19/19) | PostgreSQL 16.13, not 17 |
| RUL-04a..k | Business-time and local-time parsing | `node --test domain/business-time.test.mjs` | PASS (11/11) | America/Chicago fixtures only |
| SIG-01..06 | Webhook signature v1 | `node --test domain/ingest-signature.test.mjs` | PASS (6/6) | Reference module, not the final API route |
| CHK-01..CHK-12 | JSON validity, API/task/decision references, counts, timestamps, enums vs schema, error catalogue, status tables, IDs, envelopes, entitlement classes | `python3 check_spec.py` over the specification sources | PASS (12/12) | Static checks; do not prove runtime behaviour |
| Junior walkthrough | TASK-001..TASK-013 followed from an empty repository | Manual review | Completed; gaps fixed in Appendix F | Simulated, not executed |
| API runtime, frontend, load, provider sandboxes | All operations end to end | Not run | NOT RUN | No repository or provider accounts exist yet |

No application code has been built. Passing checks above cover the delivered schema, reference modules and document consistency only.

# Appendix I - Audit Findings on v1.0 and Changes in v1.1

| # | v1.0 location | Classification | Finding | Consequence | Repair in v1.1 |
|---|---|---|---|---|---|
| A-01 | Sections 7.3, 15, 16 | Incorrect technical fact | `SET LOCAL app.org_id = $1` cannot use a bind parameter (DB-01) | Tenant context code would fail on first use | `set_config(..., true)` everywhere |
| A-02 | Sections 13.1-13.2 vs API-003, 006, 008, 013, 015 | Confirmed contradiction | `setup_pending` was not writable, so setup could not finish; ingest of the test event was also blocked | New customers could never start a trial | Entitlement classes; verification event starts the trial |
| A-03 | Section 13.2 | Confirmed contradiction | Blanket write guard in read_only blocked checkout, support revoke, member deactivation and source disable | Recovery and security actions impossible | `control` class allowed in every state |
| A-04 | Sections 7.3, 10, 15 | Missing implementation detail | Ingest, `/me`, invitation acceptance, billing webhooks and support access needed rows before org context exists; no lookup path defined under FORCE RLS | Those endpoints would see no rows | Seven SECURITY DEFINER lookups (Section 15.2), tested (DB-06, DB-19) |
| A-05 | Section 15 | Incorrect technical claim | Scanner "column grant" cannot see rows under FORCE RLS | Timers would never fire | Explicit scanner policy plus column grants (DB-09) |
| A-06 | Sections 12, 14 | Design defect | Alert key `(lead_id, rule_step, policy_version)` suppressed later cycles (follow-ups, reopen) and had no per-recipient delivery | Missed reminders; multi-manager escalation untracked | Alert per timer occurrence + `alert_deliveries` (DB-11) |
| A-07 | Section 14 DDL vs all examples | Confirmed contradiction | uuid keys in DDL but prefixed IDs (`lead_...`) in examples, with no mapping | Clients and DB disagree on IDs | UUIDv7 everywhere (DEC-003, CHK-08) |
| A-08 | Section 30 vs DDL vs API-029/032 | Confirmed contradiction | `reopened` and `merged` states not allowed by the CHECK; `contacted -> won` example contradicted the state machine | Runtime constraint errors | Canonical transition table (Section 30.1); schema includes `merged` (DB-13) |
| A-09 | API-001 | Confirmed contradiction | 503 on Redis loss contradicted "ingest continues" | Load balancer removes every API instance | 200 `degraded`; 503 only for PostgreSQL |
| A-10 | Section 9.1 | Unsupported claim | "Form builders and CMS plugins that support webhooks" can compute HMAC signatures | Pilot may be unable to connect | Added `secret_header` mode; mode chosen per pilot tool (OD-01) |
| A-11 | Section 9 | Missing implementation detail | Signature format, encoding, raw-body rule and rotation behaviour undefined | Incompatible implementations | Section 9.4 + tested reference (SIG-01..06) |
| A-12 | API-013 | Missing policy | Idempotent replay would return or store the show-once secret | Secret stored in plaintext in idempotency table | R-IDEM-3 redaction + replay example |
| A-13 | API-011 | Incorrect claim | "Clerk sessions for this organization are revoked" - Clerk sessions are not per LeadGuard organization | Misleading; could sign the user out of other orgs | Membership check per request; no Clerk revocation |
| A-14 | Section 35 | Incorrect configuration | `CLERK_JWT_ISSUER` is not a Clerk SDK variable; `CLERK_PUBLISHABLE_KEY` missing | Startup failure | Variables from EV-002 |
| A-15 | Section 18 / API-022 | Confirmed contradiction | Per-section inbox pagination promised but one `next_cursor` returned | Sections could not page | Per-section cursors |
| A-16 | API-035 vs API-004 | Confirmed contradiction | Preview assumed Saturday closed while the org example had Saturday open | Wrong due time shown | Preview states hours version 3; RUL-04b/c test both |
| A-17 | API-036, API-040, API-031 | Confirmed contradiction | Alert `alr_...H3B9D` attached to two different leads; escalation times did not match due times | QA fixtures inconsistent | Fixture rewritten (Section 18.4); CHK-04 |
| A-18 | API-004, API-008, API-042 | Confirmed contradiction | Plan limits differed (5 vs 10 members, 2 vs 3 sources, 500 vs 1000 leads) | Inconsistent limit enforcement | One set of illustrative limits (OD-03) |
| A-19 | Many contracts | Confirmed contradiction | Response `meta.timestamp` earlier than events in the same response | Fixture time travel | Per-operation timestamps; CHK-04 |
| A-20 | Section 9.2 vs API-018 | Missing operation | Re-enable promised but no endpoint | Disabled sources could not return | API-019 added (52 operations) |
| A-21 | Section 37 | Unsupported metric | "Overdue at end of day" read from current inbox count; escalation metric implied causation | Pilot proof not credible | Daily snapshot table; non-causal wording; cohort definitions |
| A-22 | Sections 10, 11 | Missing implementation detail | No rule for conflicting phone/email matches, no eligible owner, no manager, inactive fixed owner, missing hours | Developers would invent behaviour | Section 10 matching rules; Section 11.2 decision table |
| A-23 | Section 11.2 | Missing implementation detail | "Ambiguous DST times rejected" with a library that silently shifts them (EV-006) | Wrong snooze times | `parseLocalWallTime` guard, tested |
| A-24 | Section 17 | Missing implementation detail | Queue-loss recovery covered only timers and alerts | Lost exports and invitation emails | Sweeper covers outbox, deliveries, exports |
| A-25 | Cover, Sections 5, 36 | Missing evidence | Versions unpinned ("Node.js LTS"), release date "October 2026" not supplied by anyone | Unreproducible builds; invented schedule | Pinned versions with evidence; no release date |
| A-26 | Whole document | Missing implementation detail | No build tasks, commands, evidence ledger or verification report | Junior developers and AI tools must invent the plan | Appendices D-H |
| A-27 | Sections 12, 20-28 | Unsupported claim | Provider-dependent endpoints (email, call, billing, bot challenge) presented without blocked status | Risk of fake success paths | Integration register (Appendix E); BLOCKED labels in contracts |
| A-28 | Ingest contracts | Proposed improvement | 202 used although the lead is committed synchronously | Misleading status | 201/200 (DEC-010) |

Audit coverage: every section, all 51 v1.0 contracts and every example were reviewed; the v1.0 file was byte-identical to the version produced earlier in this conversation. Not covered: runtime behaviour of an implementation (none exists), provider documentation that was not accessible, and production infrastructure.

::: callout-grey
FINAL IMPLEMENTATION RULE

Build the smallest complete enquiry-to-action workflow and prove it with a real customer. One source of truth per decision, one owner per lead, one alert per timer occurrence. Do not add a connector, channel or feature until the pilot shows it is needed and it can be verified with real data. Never fake a provider success.
:::
