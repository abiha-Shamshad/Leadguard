#!/usr/bin/env python3
"""Generate the endpoint registry and full contracts (with request, success and error results)."""
import json, sys

RID = "req_01J9X4B7M2"
TS = "2026-10-14T15:42:11Z"

def ok(data, msg=None):
    d = {"success": True}
    if msg:
        d["message"] = msg
    d["data"] = data
    d["meta"] = {"api_version": "v1", "request_id": RID, "timestamp": TS}
    return d

def err(code, message, retryable=False, details=None):
    return {"success": False,
            "error": {"code": code, "message": message, "retryable": retryable, "details": details or {}},
            "meta": {"api_version": "v1", "request_id": RID}}

AUTH = "Authorization, X-Org-Id (multi-org users), X-Request-ID"
AUTH_W = AUTH + ", Idempotency-Key, Content-Type"
AUTH_V = AUTH + ", Content-Type"

LEAD = {
    "id": "lead_01J9X3M8ZP", "status": "new",
    "contact": {"name": "Dana Morales", "email": "dana.morales@example.com", "phone": "+15125550142"},
    "message": "Water heater leaking, need someone today.",
    "source": {"id": "src_01J9X3K6Q8", "name": "Website contact form", "type": "web_form_webhook"},
    "owner": {"user_id": "usr_01J9W2T4AA", "name": "Chris Patel"},
    "next_action": "First call",
    "due_at": "2026-10-14T15:57:10Z", "due_at_local": "Oct 14, 10:57 AM CDT",
    "due_state": "due_soon", "first_action_at": None, "version": 1,
    "created_at": "2026-10-14T15:42:11Z"}

E = []  # endpoints
TS_OVERRIDE = {
    "Accept invitation": "2026-10-14T15:42:11Z", "Assign or claim lead": "2026-10-14T16:02:30Z",
    "Log contact attempt or note": "2026-10-14T15:50:05Z", "Change lead status": "2026-10-14T17:20:01Z",
    "Lead timeline": "2026-10-14T16:32:00Z", "List my alerts": "2026-10-14T16:28:00Z",
    "Acknowledge alert": "2026-10-14T16:29:41Z", "Revoke support access": "2026-10-14T16:05:01Z",
    "Merge duplicate lead": "2026-10-14T16:40:00Z", "Source delivery log": "2026-10-14T15:43:00Z"}
def ep(**k):
    E.append(k)

# ------------------------------------------------------------------ System & organization
ep(domain="System and Organization", m="GET", p="/internal/v1/health", t="Service health",
   purpose="Liveness and readiness for load balancer and uptime monitor; private network only.",
   perm="None (private network)", hdr="X-Request-ID", params="None",
   idem="Read-only.", audit="None.", event="None.", worker="None.",
   req=None, code=200,
   res={"status": "ready", "checks": {"postgres": "ok", "redis": "ok", "outbox_lag_seconds": 2, "oldest_pending_timer_seconds": 14}, "version": "1.1.0"},
   extra=[("Degraded but still serving (Redis down)", 200, {"status": "degraded", "checks": {"postgres": "ok", "redis": "unavailable", "outbox_lag_seconds": 95, "oldest_pending_timer_seconds": 140}, "version": "1.1.0"})],
   errs=[(200, "Ready or degraded - keep the instance in the load balancer"), (503, "PostgreSQL unavailable - remove the instance")],
   eres=(503, {"status": "unavailable", "checks": {"postgres": "unavailable"}, "version": "1.1.0"}),
   rules=["Never returns hostnames, connection strings or error stack traces.",
          "Readiness fails only when PostgreSQL is unreachable. Redis loss returns 200 `degraded`, so ingest and lead writes keep working while alerts are delayed and later rebuilt by the sweeper.",
          "The uptime monitor alerts on `degraded` from the body; the load balancer only uses the status code."])

ep(domain="System and Organization", m="GET", p="/api/v1/me", t="Current user and memberships",
   purpose="Return the signed-in user, organizations, role, and effective permissions for the UI.",
   perm="Authenticated user", hdr=AUTH, params="None",
   idem="Read-only.", audit="None.", event="None.", worker="None.",
   req=None, code=200,
   res=ok({"user": {"id": "usr_01J9W2T4AA", "name": "Chris Patel", "email": "chris@acmeplumbing.com"},
           "active_org": {"id": "org_01J9W1R9CD", "name": "Acme Plumbing", "role": "owner", "time_zone": "America/Chicago"},
           "organizations": [{"id": "org_01J9W1R9CD", "name": "Acme Plumbing", "role": "owner"}],
           "permissions": ["org.manage", "members.manage", "sources.manage", "leads.read", "leads.write", "leads.assign", "rules.manage", "dashboard.read", "billing.manage", "exports.create", "support.grant"],
           "subscription_state": "trialing", "setup_complete": False}),
   errs=[(200, "Success"), (401, "Missing or invalid session")],
   eres=(401, err("AUTHENTICATION_REQUIRED", "Your session has expired. Sign in again.")),
   rules=["A Clerk user with no membership receives `organizations: []` and is routed to organization setup."])

ep(domain="System and Organization", m="POST", p="/api/v1/organizations", t="Create organization",
   purpose="First step of guided setup: create the organization and make the caller its owner.",
   perm="Authenticated user", hdr=AUTH_W, params="None",
   idem="Idempotency-Key required. A user may own at most 3 organizations in Release 1.",
   audit="org.created", event="org.created", worker="None.",
   req={"name": "Acme Plumbing", "time_zone": "America/Chicago", "country": "US",
        "business_hours": [{"weekday": d, "open": "08:00", "close": "18:00"} for d in ["mon", "tue", "wed", "thu", "fri"]]},
   code=201,
   res=ok({"org": {"id": "org_01J9W1R9CD", "name": "Acme Plumbing", "time_zone": "America/Chicago", "country": "US"},
           "membership": {"role": "owner"},
           "subscription": {"state": "setup_pending", "trial_starts": "after_first_verified_source"},
           "follow_up_policy": {"version": 1, "first_response_minutes": 15},
           "setup": {"next_step": "connect_source"}}, "Organization created."),
   errs=[(201, "Created"), (200, "Same Idempotency-Key replayed"), (400, "Invalid time zone or hours"), (401, "Unauthenticated"), (409, "Idempotency conflict"), (422, "ORG_LIMIT_REACHED - user already owns 3 organizations")],
   eres=(400, err("VALIDATION_FAILED", "Check the highlighted fields.", details={"fields": {"time_zone": "Use a valid IANA time zone such as America/Chicago."}})),
   rules=["Creates a default follow-up policy (version 1) so rules work immediately.",
          "Trial clock does not start here; it starts after the first verified source (Section 13)."])

ep(domain="System and Organization", m="GET", p="/api/v1/organizations/current", t="Read organization",
   purpose="Organization profile, business hours, setup progress and plan limits.",
   perm="Any member", hdr=AUTH, params="None",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"id": "org_01J9W1R9CD", "name": "Acme Plumbing", "time_zone": "America/Chicago", "country": "US",
           "business_hours": {"version": 2, "days": [{"weekday": "mon", "open": "08:00", "close": "18:00"}, {"weekday": "sat", "open": "09:00", "close": "13:00"}], "holidays": ["2026-11-26", "2026-12-25"]},
           "setup": {"org_created": True, "source_verified": True, "team_invited": False, "complete": False},
           "plan_id": "team", "subscription_state": "trialing", "limits": {"members": {"used": 2, "max": 10}, "sources": {"used": 2, "max": 3}, "leads_this_month": {"used": 38, "max": 1000}},
           "version": 4}),
   errs=[(200, "Success"), (401, "Unauthenticated"), (404, "Not a member of this organization")],
   eres=(404, err("NOT_FOUND", "Organization not found.")),
   rules=["Limits shown are the plan's configured limits; they are never estimated."])

ep(domain="System and Organization", m="PATCH", p="/api/v1/organizations/current", t="Update organization",
   purpose="Change organization name, time zone or country.",
   perm="org.manage", hdr=AUTH_V, params="None",
   idem="expected_version required.", audit="org.updated (changed field names only)", event="org.updated", worker="Time-zone change enqueues due-time recomputation for open leads.",
   req={"expected_version": 4, "time_zone": "America/Denver"}, code=200,
   res=ok({"id": "org_01J9W1R9CD", "time_zone": "America/Denver", "version": 5, "recompute": {"open_leads": 17, "status": "queued"}}, "Organization updated."),
   errs=[(200, "Updated"), (400, "Invalid value"), (403, "Not permitted"), (409, "Stale version"), (423, "Subscription inactive")],
   eres=(409, err("VERSION_CONFLICT", "Settings were changed by someone else. Reload and try again.", details={"current_version": 5})),
   rules=["Existing due instants are recomputed by the worker and each change is written to the lead timeline."])

ep(domain="System and Organization", m="PUT", p="/api/v1/organizations/current/business-hours", t="Replace business hours",
   purpose="Set weekly opening hours and holidays; creates a new business-hours version.",
   perm="org.manage", hdr=AUTH_V, params="None",
   idem="expected_version required; PUT replaces the whole schedule.", audit="org.business_hours_changed", event="org.business_hours_changed", worker="Recompute due times for open leads.",
   req={"expected_version": 2, "days": [{"weekday": "mon", "open": "07:30", "close": "18:00"}, {"weekday": "tue", "open": "07:30", "close": "18:00"}, {"weekday": "sat", "open": None, "close": None}], "holidays": ["2026-11-26", "2026-12-25"]},
   code=200,
   res=ok({"business_hours_version": 3, "effective_at": "2026-10-14T15:42:11Z", "open_leads_recomputed": "queued"}, "Business hours saved."),
   errs=[(200, "Saved"), (400, "Overlapping or invalid intervals"), (403, "Not permitted"), (409, "Stale version")],
   eres=(400, err("VALIDATION_FAILED", "Opening time must be before closing time.", details={"fields": {"days[1].close": "Must be after 07:30."}})),
   rules=["At least one open interval per week is required.", "Leads keep the business-hours version used for their current due time."])

# ------------------------------------------------------------------ Team
ep(domain="Team and Invitations", m="GET", p="/api/v1/members", t="List members",
   purpose="Team list with role, status and current open-lead load (for assignment).",
   perm="members.manage or leads.assign", hdr=AUTH, params="status (active|invited|deactivated), cursor, limit",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"items": [
       {"user_id": "usr_01J9W2T4AA", "name": "Chris Patel", "email": "chris@acmeplumbing.com", "role": "owner", "status": "active", "open_leads": 4},
       {"user_id": "usr_01J9W8H2KD", "name": "Maria Lopez", "email": "maria@acmeplumbing.com", "role": "member", "status": "active", "open_leads": 9},
       {"invitation_id": "inv_01J9XA1B2C", "email": "sam@acmeplumbing.com", "role": "member", "status": "invited", "expires_at": "2026-10-21T15:42:11Z"}],
       "next_cursor": None}),
   errs=[(200, "Success"), (401, "Unauthenticated"), (403, "Not permitted")],
   eres=(403, err("AUTHORIZATION_DENIED", "You do not have permission to view the team.")),
   rules=["`open_leads` is an exact count of leads owned with status new or attempted."])

ep(domain="Team and Invitations", m="POST", p="/api/v1/invitations", t="Invite member",
   purpose="Send an email invitation with a role.",
   perm="members.manage", hdr=AUTH_W, params="None",
   idem="Idempotency-Key required; one pending invitation per email per org.", audit="member.invited", event="member.invited", worker="alert-deliveries (invitation email).",
   req={"email": "sam@acmeplumbing.com", "role": "member"}, code=201,
   res=ok({"invitation_id": "inv_01J9XA1B2C", "email": "sam@acmeplumbing.com", "role": "member", "status": "pending", "expires_at": "2026-10-21T15:42:11Z", "email_delivery": "queued"}, "Invitation sent."),
   errs=[(201, "Created"), (400, "Invalid email or role"), (403, "Managers cannot invite owners"), (409, "Already a member or pending invite"), (422, "Member limit reached"), (423, "Subscription inactive")],
   eres=(422, err("PLAN_LIMIT_REACHED", "Your plan allows 10 team members. Remove a member or change plan.", details={"limit": "members", "used": 10, "max": 10})),
   rules=["The token is random, stored hashed, single-use and valid for 7 days.", "`email_delivery: queued` is not a delivery claim; the members list shows delivery failures."])

ep(domain="Team and Invitations", m="POST", p="/api/v1/invitations/accept", t="Accept invitation",
   purpose="Signed-in invitee accepts an invitation token.",
   perm="Authenticated user whose verified email matches the invitation", hdr="Authorization, X-Request-ID, Content-Type", params="None",
   idem="Token is single-use; replay by the same user returns the existing membership.", audit="member.joined", event="member.joined", worker="None.",
   req={"token": "lgi_7d3f...redacted"}, code=200,
   res=ok({"org": {"id": "org_01J9W1R9CD", "name": "Acme Plumbing"}, "membership": {"role": "member", "status": "active"}}, "You joined Acme Plumbing."),
   errs=[(200, "Joined"), (400, "Malformed token"), (403, "Email does not match"), (410, "Expired or revoked")],
   eres=(410, err("INVITATION_EXPIRED", "This invitation has expired. Ask your manager to send a new one.")),
   rules=["Tokens are passed in the body, never in a URL query parameter after the landing page."])

ep(domain="Team and Invitations", m="PATCH", p="/api/v1/members/{memberId}", t="Change member role",
   purpose="Change a member's role.",
   perm="members.manage (only owners can grant or remove owner)", hdr=AUTH_V, params="memberId (user ID)",
   idem="expected_version required.", audit="member.role_changed", event="member.role_changed", worker="None.",
   req={"expected_version": 2, "role": "manager"}, code=200,
   res=ok({"user_id": "usr_01J9W8H2KD", "role": "manager", "version": 3}, "Role updated."),
   errs=[(200, "Updated"), (403, "Not permitted"), (404, "Member not found"), (409, "Stale version"), (422, "Would leave the org without an owner")],
   eres=(422, err("LAST_OWNER", "An organization must keep at least one owner.")),
   rules=["Permission changes apply on the next request; no cached role is trusted for writes."])

ep(domain="Team and Invitations", m="POST", p="/api/v1/members/{memberId}/deactivate", t="Deactivate member",
   purpose="Remove access and hand the member's open leads to a chosen person or the unassigned queue.",
   perm="members.manage", hdr=AUTH_W, params="memberId",
   idem="Idempotency-Key required.", audit="member.deactivated", event="member.deactivated", worker="Timers for reassigned leads are recomputed.",
   req={"reassign_to": "usr_01J9W2T4AA", "reason": "Left the company"}, code=200,
   res=ok({"user_id": "usr_01J9W8H2KD", "status": "deactivated", "leads_reassigned": 9, "access_removed": True}, "Member deactivated."),
   errs=[(200, "Deactivated"), (403, "Not permitted"), (404, "Not found"), (422, "Cannot deactivate the last owner")],
   eres=(404, err("NOT_FOUND", "Member not found.")),
   rules=["Access ends on the next request because every request re-reads the membership. The Clerk session is not revoked, because the same user may belong to other organizations.", "The user's history remains in timelines; leads are reassigned in the same transaction and their timers recomputed."])

# ------------------------------------------------------------------ Sources
SRC = {"id": "src_01J9X3K6Q8", "name": "Website contact form", "type": "web_form_webhook", "status": "verified",
       "last_event_at": "2026-10-14T15:42:10Z", "verified_at": "2026-10-10T18:03:44Z",
       "events_24h": {"accepted": 6, "duplicate": 1, "rejected": 0}}
ep(domain="Sources", m="GET", p="/api/v1/sources", t="List sources",
   purpose="Sources with exact status and last event, for setup and source health.",
   perm="sources.manage or dashboard.read", hdr=AUTH, params="None",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"items": [SRC, {"id": "src_01J9Y0C1RT", "name": "Office phone line", "type": "call_webhook", "status": "failing",
                            "last_event_at": "2026-10-13T21:10:02Z", "last_error": {"reason": "SIGNATURE_INVALID", "at": "2026-10-14T14:01:12Z", "count": 3}}]}),
   errs=[(200, "Success"), (403, "Not permitted")],
   eres=(403, err("AUTHORIZATION_DENIED", "Only owners and managers can manage sources.")),
   rules=["Status values are exactly those of Section 9.2; the UI shows Connected only for `verified`."])

ep(domain="Sources", m="POST", p="/api/v1/sources", t="Create source",
   purpose="Create a web form (webhook or embed) or call source; returns the endpoint and the secret once.",
   perm="sources.manage", hdr=AUTH_W, params="None",
   idem="Idempotency-Key required.", audit="source.created", event="source.created", worker="None.",
   req={"type": "web_form_webhook", "name": "Website contact form", "field_mapping": {"name": "full_name", "email": "email", "phone": "phone", "message": "comments"}},
   code=201,
   res=ok({"source": {"id": "src_01J9X3K6Q8", "type": "web_form_webhook", "status": "draft"},
           "endpoint_url": "https://api.leadguard.io/ingest/v1/forms/sk_live_4f8a2c91",
           "signing_secret": "whsec_9b1e...shown_once",
           "signature": {"header": "X-LeadGuard-Signature", "algorithm": "HMAC-SHA256", "signed_payload": "{timestamp}.{raw_body}"},
           "next_step": "send_test_event"}, "Source created. Copy the secret now; it will not be shown again."),
   errs=[(201, "Created"), (200, "Same Idempotency-Key replayed (secret not included)"), (400, "Invalid type or mapping"), (403, "Not permitted"), (422, "Source limit reached or call source not enabled for this org"), (423, "Subscription inactive")],
   eres=(422, err("SOURCE_TYPE_NOT_ENABLED", "Call sources are enabled only after the provider is verified for your account.", details={"type": "call_webhook"})),
   extra=[("Replay with the same Idempotency-Key (secret is never replayed)", 200, ok({"source": {"id": "src_01J9X3K6Q8", "type": "web_form_webhook", "status": "draft"}, "endpoint_url": "https://api.leadguard.io/ingest/v1/forms/sk_live_4f8a2c91", "signing_secret": None, "secret_available": False, "next_step": "rotate_secret_if_not_copied"}, "Source already created. The secret is shown only once; rotate it if it was not copied."))],
   rules=["`auth_mode` is `hmac_v1` (default, for tools that can compute a signature), `secret_header` (for tools that can only send a fixed header `X-LeadGuard-Source-Secret`) or `embed`.",
          "Embed sources require `allowed_origins` (exact https origins) and return an embed snippet instead of a secret.",
          "The plaintext secret is never written to `idempotency_keys`; a replay returns `signing_secret: null` and `secret_available: false`.",
          "Call sources require a configured provider adapter (`provider_key`) approved for this organization."])

ep(domain="Sources", m="GET", p="/api/v1/sources/{sourceId}", t="Read source and verification state",
   purpose="Source detail polled by the setup screen while waiting for the test event.",
   perm="sources.manage", hdr=AUTH, params="sourceId",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({**SRC, "status": "testing", "verification": {"started_at": "2026-10-14T15:30:00Z", "expires_at": "2026-10-14T15:45:00Z",
           "steps": [{"step": "endpoint_reachable", "state": "passed"}, {"step": "signature_valid", "state": "failed", "detail": "Signature did not match. Check the signing secret in your form tool."}, {"step": "fields_mapped", "state": "not_reached"}, {"step": "lead_created", "state": "not_reached"}]}}),
   errs=[(200, "Success"), (404, "Not found")],
   eres=(404, err("NOT_FOUND", "Source not found.")),
   rules=["The steps list shows the exact step that failed, as the CEO direction requires."])

ep(domain="Sources", m="POST", p="/api/v1/sources/{sourceId}/test-event", t="Start source verification",
   purpose="Open a 15-minute verification window; the customer then submits their real form or makes a test call.",
   perm="sources.manage", hdr=AUTH_W, params="sourceId",
   idem="Idempotency-Key required; an open window is returned instead of a new one.", audit="source.verification_started", event="None.", worker="Window expiry job.",
   req={"window_minutes": 15}, code=202,
   res=ok({"source_id": "src_01J9X3K6Q8", "status": "testing", "verification_id": "ver_01J9XB7Q2M", "expires_at": "2026-10-14T15:57:11Z",
           "instructions": "Submit your website form once with a real-looking enquiry. It will appear in your inbox marked TEST."}, "Waiting for your test event."),
   errs=[(202, "Window open"), (403, "Not permitted"), (404, "Not found"), (409, "Source disabled")],
   eres=(409, err("SOURCE_DISABLED", "Enable this source before testing it.")),
   rules=["The first valid event in the window sets the source to `verified`, marks that lead `is_test` (excluded from dashboard counts) and, if the subscription is `setup_pending`, moves it to `trialing` in the same transaction.",
          "Without an open window, a `draft` or `testing` source rejects events with 409 `SOURCE_NOT_VERIFIED`, so untested configurations never create real leads.",
          "LeadGuard never sends a synthetic event on the customer's behalf; verification proves the real path."])

ep(domain="Sources", m="GET", p="/api/v1/sources/{sourceId}/events", t="Source delivery log",
   purpose="Every delivery attempt with outcome and reason, for investigation and recovery.",
   perm="sources.manage", hdr=AUTH, params="sourceId; outcome (accepted|duplicate|rejected|failed); cursor; limit",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"items": [
       {"event_id": "sev_01J9X3M8ZN", "received_at": "2026-10-14T15:42:10Z", "outcome": "accepted", "lead_id": "lead_01J9X3M8ZP", "dedupe_key": "form:wpf_entry_8841"},
       {"event_id": "sev_01J9X3N2QA", "received_at": "2026-10-14T15:42:41Z", "outcome": "duplicate", "lead_id": "lead_01J9X3M8ZP", "dedupe_key": "form:wpf_entry_8841"},
       {"event_id": "sev_01J9X1AA7Y", "received_at": "2026-10-14T13:05:09Z", "outcome": "rejected", "reason": "SIGNATURE_INVALID", "lead_id": None}],
       "next_cursor": "c_eyJrIjoiMjAyNi0xMC0xNCJ9"}),
   errs=[(200, "Success"), (404, "Not found")],
   eres=(404, err("NOT_FOUND", "Source not found.")),
   rules=["The log shows outcome and reason only; contact details are visible on the linked lead, not in the log."])

ep(domain="Sources", m="POST", p="/api/v1/sources/{sourceId}/rotate-secret", t="Rotate signing secret",
   purpose="Issue a new secret; the previous one stays valid for 24 hours.",
   perm="sources.manage", hdr=AUTH_W, params="sourceId",
   idem="Idempotency-Key required.", audit="source.secret_rotated", event="None.", worker="Old-secret expiry job.",
   req={}, code=200,
   res=ok({"source_id": "src_01J9X3K6Q8", "signing_secret": "whsec_c41d...shown_once", "previous_secret_valid_until": "2026-10-15T15:42:11Z"}, "New secret created. Update your form tool within 24 hours."),
   errs=[(200, "Rotated"), (403, "Not permitted"), (404, "Not found"), (422, "Embed sources have no secret")],
   eres=(422, err("NOT_APPLICABLE", "Embed sources do not use a signing secret.")),
   rules=["Secrets are stored encrypted; only a hash prefix is shown afterwards."])

ep(domain="Sources", m="POST", p="/api/v1/sources/{sourceId}/disable", t="Disable source",
   purpose="Stop accepting events from a source.",
   perm="sources.manage", hdr=AUTH_W, params="sourceId",
   idem="Idempotency-Key required.", audit="source.disabled", event="source.disabled", worker="None.",
   req={"reason": "Replaced by new form"}, code=200,
   res=ok({"source_id": "src_01J9X3K6Q8", "status": "disabled", "disabled_at": "2026-10-14T15:42:11Z"}, "Source disabled. New events will be rejected."),
   errs=[(200, "Disabled"), (403, "Not permitted"), (404, "Not found")],
   eres=(403, err("AUTHORIZATION_DENIED", "Only owners and managers can disable sources.")),
   rules=["Existing leads from the source are unchanged.", "Allowed in every subscription state, including read_only (control operation).", "Re-enable with the next operation; it returns the source to `testing`, never directly to `verified`."])

ep(domain="Sources", m="POST", p="/api/v1/sources/{sourceId}/enable", t="Re-enable source",
   purpose="Turn a disabled source back on; it must be re-verified before showing Connected.",
   perm="sources.manage", hdr=AUTH_W, params="sourceId",
   idem="Idempotency-Key required; enabling an already-enabled source returns its current state.", audit="source.enabled", event="source.enabled", worker="None.",
   req={}, code=200,
   res=ok({"source_id": "src_01J9X3K6Q8", "status": "testing", "next_step": "send_test_event"}, "Source enabled. Send a test enquiry to reconnect it."),
   errs=[(200, "Enabled"), (403, "Not permitted"), (404, "Not found"), (423, "Subscription read-only")],
   eres=(423, err("SUBSCRIPTION_INACTIVE", "Reactivate your subscription before enabling sources.", details={"state": "read_only"})),
   rules=["Never returns the source to `verified` directly; the next valid event in a verification window does."])

# ------------------------------------------------------------------ Ingest
ep(domain="Ingestion", m="POST", p="/ingest/v1/forms/{sourceKey}", t="Receive website form event",
   purpose="Public endpoint for signed webhooks and embed submissions; creates or links a lead.",
   perm="Source key + HMAC signature (webhook) or origin + bot challenge (embed)",
   hdr="hmac_v1: X-LeadGuard-Timestamp + X-LeadGuard-Signature; secret_header: X-LeadGuard-Source-Secret; embed: Origin + challenge token; Content-Type", params="sourceKey (public routing key, not a secret)",
   idem="Unique (source_id, dedupe_key). Duplicate delivery returns the original result.", audit="lead.created by system actor `source:<id>`", event="lead.created or lead.repeat_enquiry", worker="lead-timers for first response and unassigned escalation.",
   req={"entry_id": "wpf_entry_8841", "submitted_at": "2026-10-14T15:42:10Z", "full_name": "Dana Morales", "email": "dana.morales@example.com", "phone": "(512) 555-0142", "comments": "Water heater leaking, need someone today.", "service": "plumbing", "zip": "78704"},
   code=201,
   res={"accepted": True, "outcome": "lead_created", "event_id": "sev_01J9X3M8ZN", "lead_id": "lead_01J9X3M8ZP", "duplicate": False, "request_id": RID},
   extra=[("Duplicate delivery result (same entry_id)", 200, {"accepted": True, "outcome": "lead_created", "event_id": "sev_01J9X3M8ZN", "lead_id": "lead_01J9X3M8ZP", "duplicate": True, "request_id": RID}),
          ("Repeat enquiry linked to an open lead", 200, {"accepted": True, "outcome": "lead_linked", "event_id": "sev_01J9XM1T4H", "lead_id": "lead_01J9X3M8ZP", "duplicate": False, "request_id": RID})],
   errs=[(201, "New lead created"), (200, "Linked to an open lead, or duplicate (original result replayed)"), (409, "SOURCE_NOT_VERIFIED - source not verified and no verification window open"), (400, "Payload invalid after mapping"), (401, "Signature invalid or timestamp outside 5 minutes"), (403, "Origin not allowed / challenge failed"), (404, "Unknown source key"), (410, "Source disabled"), (413, "Body over 64 KB"), (423, "Subscription inactive"), (429, "Rate limited")],
   eres=(401, {"accepted": False, "error": {"code": "SIGNATURE_INVALID", "message": "Signature verification failed.", "retryable": False}, "request_id": RID}),
   rules=["Ingest responses use a minimal envelope (no organization data) because the caller is an external system.",
          "Signature `hmac_v1` is LeadGuard's own scheme: `v1=` + lowercase hex HMAC-SHA256 of `{timestamp}.{raw body bytes}`, 300-second tolerance, constant-time compare, previous secret accepted for 24 h after rotation (reference code verified: domain/ingest-signature.mjs).",
          "Embed submissions reduce abuse but cannot prove the enquiry is genuine; they are labelled `embed` in the delivery log and sales must not call them forgery-proof.",
          "Response is sent only after commit, so a retry after a network timeout is safe.",
          "At least one of email or phone is required; otherwise 400 `CONTACT_REQUIRED` and the event is logged as rejected."])

ep(domain="Ingestion", m="POST", p="/ingest/v1/calls/{sourceKey}", t="Receive call event (provider-neutral)",
   purpose="Call provider webhook; the adapter maps provider fields to the canonical event. Missed or short calls create or link a lead.",
   perm="Source key + provider signature verified by the adapter. INTEGRATION STATUS: BLOCKED until the pilot call provider is chosen (INT-002)",
   hdr="Provider signature header(s) as documented by the selected provider, Content-Type", params="sourceKey",
   idem="Unique (source_id, provider_call_id + event_type).", audit="lead.created / lead.call_logged", event="lead.created or lead.activity_added", worker="lead-timers.",
   req={"_note": "LeadGuard normalized call event (test double). Real provider payload and signature are defined in INT-002 after provider selection.", "provider": "pilot_call_provider", "call_id": "CA7f3e19b2", "event_type": "call.completed", "direction": "inbound", "from": "+15125550199", "to": "+15125550100", "started_at": "2026-10-14T16:02:00Z", "duration_seconds": 0, "answered": False, "voicemail": True},
   code=201,
   res={"accepted": True, "outcome": "lead_created", "event_id": "sev_01J9XC4R6P", "lead_id": "lead_01J9XC4R7A", "duplicate": False, "classification": "missed_call", "request_id": RID},
   extra=[("Answered call logged on an existing lead", 200, {"accepted": True, "outcome": "activity_logged", "event_id": "sev_01J9XD0K2B", "lead_id": "lead_01J9X3M8ZP", "duplicate": False, "classification": "answered_call_logged", "request_id": RID})],
   errs=[(201, "New lead created"), (200, "Linked, activity logged, or duplicate"), (400, "Unmappable payload"), (401, "Provider signature invalid"), (404, "Unknown source key"), (410, "Source disabled"), (423, "Subscription inactive"), (429, "Rate limited")],
   eres=(400, {"accepted": False, "error": {"code": "PAYLOAD_UNMAPPABLE", "message": "Required field 'from' missing after provider mapping.", "retryable": False}, "request_id": RID}),
   rules=["Missed and voicemail calls create a lead (or link to an open lead with the same number); answered calls longer than 30 seconds are logged as contact activity, not new leads.",
          "Recording and transcription are not stored in Release 1.",
          "Provider-specific field names and signature schemes come from that provider's published documentation only; they are added at G0 when the pilot provider is known."])

# ------------------------------------------------------------------ Leads
ep(domain="Inbox and Leads", m="GET", p="/api/v1/inbox", t="Needs Action inbox",
   purpose="First screen: what needs action now, who owns it and what happens next.",
   perm="leads.read", hdr=AUTH, params="view (mine|team); section (overdue|due_soon|unassigned) + cursor to page one section; limit (default 25, max 100)",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"counts": {"overdue": 3, "due_soon": 5, "unassigned": 2},
           "sections": {
               "overdue": [{"id": "lead_01J9W9P1XY", "name": "Greg Hall", "source": "Website contact form", "owner": "Maria Lopez", "next_action": "Second call attempt", "due_at_local": "Oct 14, 9:30 AM CDT", "overdue_minutes": 72, "escalated": True, "version": 5}],
               "due_soon": [{"id": "lead_01J9X3M8ZP", "name": "Dana Morales", "source": "Website contact form", "owner": "Chris Patel", "next_action": "First call", "due_at_local": "Oct 14, 10:57 AM CDT", "due_in_minutes": 15, "version": 1}],
               "unassigned": [{"id": "lead_01J9XC4R7A", "name": None, "phone_masked": "(512) ***-0199", "source": "Office phone line", "next_action": "Return missed call", "waiting_minutes": 6, "version": 1}]},
           "cursors": {"overdue": None, "due_soon": None, "unassigned": None}}),
   errs=[(200, "Success"), (401, "Unauthenticated")],
   eres=(401, err("AUTHENTICATION_REQUIRED", "Your session has expired. Sign in again.")),
   rules=["Members see their own and unassigned leads; managers and owners can switch to the team view.",
          "Each section is bounded (25 items) with its own cursor; counts are exact."])

ep(domain="Inbox and Leads", m="POST", p="/api/v1/leads/search", t="Search and list leads",
   purpose="Filter and search leads; contact search terms travel in the body, never the URL.",
   perm="leads.read", hdr=AUTH_V, params="None (body)",
   idem="Read-only POST; no Idempotency-Key.", audit="lead.searched (no terms recorded)", event="None.", worker="None.",
   req={"query": "morales", "status": ["new", "attempted", "contacted"], "owner_id": None, "source_id": None, "created_from": "2026-10-01", "limit": 25, "cursor": None},
   code=200,
   res=ok({"items": [{"id": "lead_01J9X3M8ZP", "name": "Dana Morales", "status": "new", "owner": "Chris Patel", "source": "Website contact form", "created_at": "2026-10-14T15:42:11Z", "due_at_local": "Oct 14, 10:57 AM CDT"}], "next_cursor": None}),
   errs=[(200, "Success"), (400, "Invalid filter"), (429, "Rate limited")],
   eres=(400, err("VALIDATION_FAILED", "Search text must be at least 2 characters.", details={"fields": {"query": "Minimum 2 characters."}})),
   rules=["Search uses trigram indexes on name and normalized email/phone within the caller's organization only."])

ep(domain="Inbox and Leads", m="POST", p="/api/v1/leads", t="Create lead manually",
   purpose="Record a walk-in or phone enquiry that did not come from a connected source.",
   perm="leads.write", hdr=AUTH_W, params="None",
   idem="Idempotency-Key required. Possible duplicates are returned as warnings, not blocked.", audit="lead.created (actor = user)", event="lead.created", worker="lead-timers.",
   req={"name": "Kim Nguyen", "phone": "512-555-0177", "email": None, "message": "Quote for bathroom remodel", "owner_id": "me"},
   code=201,
   res=ok({**LEAD, "id": "lead_01J9XE5S1D", "contact": {"name": "Kim Nguyen", "email": None, "phone": "+15125550177"}, "message": "Quote for bathroom remodel", "source": {"id": None, "name": "Manual entry", "type": "manual"},
           "possible_duplicates": [{"id": "lead_01J8ZZ1A0B", "name": "Kim Nguyen", "status": "lost", "created_at": "2026-08-02T14:00:00Z"}]}, "Lead created."),
   errs=[(201, "Created"), (400, "Email or phone required"), (403, "Not permitted"), (409, "Idempotency conflict"), (422, "Monthly lead limit reached"), (423, "Subscription inactive")],
   eres=(423, err("SUBSCRIPTION_INACTIVE", "Your subscription has ended. Leads are read-only; export your data or reactivate.", details={"state": "read_only"})),
   rules=["Manual leads follow the same assignment and due-time rules as source leads."])

ep(domain="Inbox and Leads", m="GET", p="/api/v1/leads/{leadId}", t="Read lead",
   purpose="Lead detail with the one primary action, due time, owner and allowed actions.",
   perm="leads.read", hdr=AUTH, params="leadId",
   idem="Read-only; returns `version` for later writes.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({**LEAD, "attributes": {"service": "plumbing", "zip": "78704"},
           "primary_action": {"label": "Call Dana", "type": "call", "tel": "+15125550142"},
           "allowed_actions": ["log_activity", "assign", "change_status", "snooze", "merge"],
           "allowed_statuses": ["attempted", "contacted", "lost", "spam"],
           "timers": [{"kind": "first_response_due", "due_at": "2026-10-14T15:57:10Z", "state": "pending"}],
           "events": [{"event_id": "sev_01J9X3M8ZN", "kind": "form_submission", "received_at": "2026-10-14T15:42:10Z"}]}),
   errs=[(200, "Success"), (401, "Unauthenticated"), (404, "Not found or not visible to this member")],
   eres=(404, err("NOT_FOUND", "Lead not found.")),
   rules=["`allowed_actions` and `allowed_statuses` are computed server-side; the UI never infers them."])

ep(domain="Inbox and Leads", m="PATCH", p="/api/v1/leads/{leadId}", t="Update lead contact details",
   purpose="Correct name, email, phone, message or next action text.",
   perm="leads.write", hdr=AUTH_V, params="leadId",
   idem="expected_version required.", audit="lead.updated (field names only)", event="lead.updated", worker="None.",
   req={"expected_version": 2, "contact": {"phone": "+15125550143"}, "next_action": "Call after 2 PM"}, code=200,
   res=ok({"id": "lead_01J9X3M8ZP", "contact": {"name": "Dana Morales", "email": "dana.morales@example.com", "phone": "+15125550143"}, "next_action": "Call after 2 PM", "version": 3}, "Lead updated."),
   errs=[(200, "Updated"), (400, "Invalid phone/email"), (403, "Not owner and not manager"), (404, "Not found"), (409, "Stale version"), (423, "Subscription inactive")],
   eres=(409, err("VERSION_CONFLICT", "This lead was changed by someone else. Reload to see the latest version.", details={"current_version": 3})),
   rules=["Status, owner and due time cannot be changed here; they have explicit endpoints."])

ep(domain="Inbox and Leads", m="POST", p="/api/v1/leads/{leadId}/assign", t="Assign or claim lead",
   purpose="Assign an owner (managers) or claim an unassigned lead (members).",
   perm="leads.assign (members: self-claim of unassigned only)", hdr=AUTH_W, params="leadId",
   idem="Idempotency-Key + expected_version.", audit="lead.assigned", event="lead.assigned", worker="Cancel unassigned escalation; recompute first-response timer for the new owner.",
   req={"expected_version": 1, "owner_id": "usr_01J9W8H2KD", "note": "Maria covers south Austin"}, code=200,
   res=ok({"id": "lead_01J9XC4R7A", "owner": {"user_id": "usr_01J9W8H2KD", "name": "Maria Lopez"}, "due_at": "2026-10-14T16:17:00Z", "due_at_local": "Oct 14, 11:17 AM CDT", "timers_cancelled": ["unassigned_escalation"], "version": 2}, "Lead assigned to Maria Lopez."),
   errs=[(200, "Assigned"), (403, "Member cannot assign to others"), (404, "Lead or member not found"), (409, "Stale version / already claimed"), (422, "Owner inactive")],
   eres=(409, err("ALREADY_CLAIMED", "Chris Patel claimed this lead a moment ago.", details={"owner_id": "usr_01J9W2T4AA", "current_version": 2})),
   rules=["Two members claiming at once: the guarded update lets exactly one succeed."])

ep(domain="Inbox and Leads", m="POST", p="/api/v1/leads/{leadId}/activities", t="Log contact attempt or note",
   purpose="Record a call, text, email, visit or note with an outcome, and set what happens next - without leaving the inbox.",
   perm="leads.write", hdr=AUTH_W, params="leadId",
   idem="Idempotency-Key required; expected_version required when the activity changes status or timers.", audit="lead.activity_added", event="lead.activity_added", worker="Timer recalculation; pending reminder or escalation cancelled when contact is made.",
   req={"expected_version": 1, "type": "call", "outcome": "no_answer", "note": "Left voicemail", "occurred_at": "2026-10-14T15:50:00Z"},
   code=201,
   res=ok({"activity": {"id": "act_01J9XF0D3K", "type": "call", "outcome": "no_answer", "occurred_at": "2026-10-14T15:50:00Z", "by": "Chris Patel"},
           "lead": {"id": "lead_01J9X3M8ZP", "status": "attempted", "first_action_at": "2026-10-14T15:50:00Z", "next_action": "Follow-up attempt 2", "due_at_local": "Oct 14, 11:50 AM CDT", "version": 2},
           "timers": {"cancelled": ["first_response_due"], "created": ["follow_up_due"]}}, "Call logged. Next attempt due 11:50 AM."),
   extra=[("Result when contact is made (outcome = reached)", 201, ok({"activity": {"id": "act_01J9XF9W1Q", "type": "call", "outcome": "reached"}, "lead": {"id": "lead_01J9X3M8ZP", "status": "contacted", "next_action": None, "due_at": None, "version": 3}, "timers": {"cancelled": ["follow_up_due", "escalation"], "created": []}, "alerts_cancelled": 1}, "Marked contacted. Pending reminders cancelled."))],
   errs=[(201, "Logged"), (400, "Invalid type/outcome or future time"), (403, "Not permitted"), (404, "Not found"), (409, "Stale version"), (423, "Subscription inactive")],
   eres=(400, err("VALIDATION_FAILED", "Activity time cannot be in the future.", details={"fields": {"occurred_at": "Must be on or before now."}})),
   rules=["Outcomes: reached, no_answer, voicemail, wrong_number, booked, not_interested, note.",
          "`reached` or `booked` moves the lead to contacted and cancels pending timers and alerts in the same transaction.",
          "Manual activities are self-reported; provider-confirmed call events are labelled separately in the timeline."])

ep(domain="Inbox and Leads", m="POST", p="/api/v1/leads/{leadId}/status", t="Change lead status",
   purpose="Move the lead through its states (qualified, won, lost, spam, reopen).",
   perm="leads.write", hdr=AUTH_W, params="leadId",
   idem="Idempotency-Key + expected_version.", audit="lead.status_changed", event="lead.status_changed", worker="Closing statuses cancel all timers and pending alerts.",
   req={"expected_version": 3, "to_status": "won", "reason": "Booked water heater replacement"}, code=200,
   res=ok({"id": "lead_01J9X3M8ZP", "status": "won", "previous_status": "contacted", "closed_at": "2026-10-14T17:20:00Z", "timers_cancelled": 0, "version": 4}, "Lead marked won."),
   errs=[(200, "Changed"), (403, "Not permitted"), (404, "Not found"), (409, "Stale version"), (422, "Transition not allowed or reason missing")],
   eres=(422, err("INVALID_TRANSITION", "A lead cannot move from 'new' to 'won'. Log contact first.", details={"from": "new", "to": "won", "allowed": ["attempted", "contacted", "lost", "spam"]})),
   rules=["Allowed transitions are listed in Section 30. `lost` and `spam` require a reason.", "Won/lost are factual outcomes; no revenue value is calculated."])

ep(domain="Inbox and Leads", m="POST", p="/api/v1/leads/{leadId}/snooze", t="Reschedule next action",
   purpose="Set a new due time for the next action (e.g. customer asked for a call tomorrow).",
   perm="leads.write", hdr=AUTH_W, params="leadId",
   idem="Idempotency-Key + expected_version.", audit="lead.rescheduled", event="lead.rescheduled", worker="Replace follow-up timer; cancel pending escalation.",
   req={"expected_version": 2, "due_at_local": "2026-10-15T09:00", "reason": "Customer asked for a call tomorrow morning"}, code=200,
   res=ok({"id": "lead_01J9X3M8ZP", "next_action": "Follow-up call", "due_at": "2026-10-15T14:00:00Z", "due_at_local": "Oct 15, 9:00 AM CDT", "version": 3}, "Rescheduled for Oct 15, 9:00 AM."),
   errs=[(200, "Rescheduled"), (400, "Past, more than 30 days ahead, DST gap or ambiguous time"), (404, "Not found"), (409, "Stale version"), (422, "Lead closed")],
   eres=(400, err("LOCAL_TIME_AMBIGUOUS", "1:30 AM happens twice on Nov 1 because clocks move back. Choose another time.", details={"due_at_local": "2026-11-01T01:30"})),
   rules=["Local time is interpreted in the organization time zone by `parseLocalWallTime()` (domain/business-time.mjs, tested): DST-gap times return `LOCAL_TIME_IN_DST_GAP` and repeated times return `LOCAL_TIME_AMBIGUOUS`; times in the past or more than 30 days ahead return `VALIDATION_FAILED`.", "A reason is required so the timeline explains why no reminder fired."])

ep(domain="Inbox and Leads", m="GET", p="/api/v1/leads/{leadId}/timeline", t="Lead timeline",
   purpose="Plain-language history explaining every event, action, reminder and escalation.",
   perm="leads.read", hdr=AUTH, params="leadId, cursor, limit",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"items": [
       {"at": "2026-10-14T15:42:10Z", "type": "event_received", "text": "Enquiry received from Website contact form"},
       {"at": "2026-10-14T15:42:11Z", "type": "assigned", "text": "Assigned to Chris Patel by round-robin rule (policy v3)"},
       {"at": "2026-10-14T15:42:11Z", "type": "due_set", "text": "First response due 10:57 AM CDT (15 min target, business hours v2)"},
       {"at": "2026-10-14T15:57:10Z", "type": "reminder", "text": "Reminder to Chris Patel - first response overdue (policy v3, first_response_due cycle 1)", "alert_id": "alr_01J9XG2A8C", "deliveries": [{"recipient": "Chris Patel", "channel": "in_app", "state": "delivered"}, {"recipient": "Chris Patel", "channel": "email", "state": "delivered"}]},
       {"at": "2026-10-14T16:27:10Z", "type": "escalation", "text": "Escalated to owner (no active manager) - overdue 30 min (policy v3, escalation cycle 1)", "alert_id": "alr_01J9XH3B9D", "deliveries": [{"recipient": "Chris Patel", "channel": "in_app", "state": "delivered"}, {"recipient": "Chris Patel", "channel": "email", "state": "accepted"}]},
       {"at": "2026-10-14T16:31:00Z", "type": "activity", "text": "Chris Patel logged a call: reached (self-reported)"},
       {"at": "2026-10-14T16:31:00Z", "type": "timer_cancelled", "text": "Follow-up reminder cancelled - lead contacted"}],
       "next_cursor": None}),
   errs=[(200, "Success"), (404, "Not found")],
   eres=(404, err("NOT_FOUND", "Lead not found.")),
   rules=["Every reminder or escalation line names the rule step and policy version that caused it.", "Email shows `accepted` when the provider accepted it and `delivered` only after a provider delivery event; it never claims delivery that was not confirmed."])

ep(domain="Inbox and Leads", m="POST", p="/api/v1/leads/{leadId}/merge", t="Merge duplicate lead",
   purpose="Merge a duplicate lead into this lead, keeping both histories.",
   perm="leads.write (manager or owner)", hdr=AUTH_W, params="leadId (the surviving lead)",
   idem="Idempotency-Key required.", audit="lead.merged", event="lead.merged", worker="Cancel timers and alerts of the merged lead.",
   req={"merge_lead_id": "lead_01J9XC4R7A", "expected_version": 3, "merge_expected_version": 2}, code=200,
   res=ok({"id": "lead_01J9X3M8ZP", "merged_lead_id": "lead_01J9XC4R7A", "events_moved": 1, "activities_moved": 2, "merged_lead_status": "merged", "version": 4}, "Leads merged."),
   errs=[(200, "Merged"), (403, "Not permitted"), (404, "Either lead not found"), (409, "Stale version"), (422, "Cannot merge a lead into itself or a closed lead")],
   eres=(422, err("MERGE_NOT_ALLOWED", "You cannot merge a lead into itself.")),
   rules=["The merged lead becomes read-only with status `merged` and a link to the survivor; nothing is deleted."])

# ------------------------------------------------------------------ Rules & alerts
POL = {"version": 3, "assignment": {"mode": "round_robin", "eligible_roles": ["member", "manager"]},
       "first_response": {"target_minutes": 15, "business_hours_only": True},
       "follow_up": {"attempt_intervals_minutes": [60, 240, 1440], "max_attempts": 4},
       "escalation": {"after_overdue_minutes": 30, "notify": ["managers"], "repeat": False},
       "unassigned_escalation_minutes": 10}
ep(domain="Rules and Alerts", m="GET", p="/api/v1/rules/follow-up-policy", t="Read follow-up policy",
   purpose="Current active policy and its version.",
   perm="leads.read (read), rules.manage (edit in UI)", hdr=AUTH, params="None",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({**POL, "updated_by": "Chris Patel", "updated_at": "2026-10-10T18:20:00Z"}),
   errs=[(200, "Success"), (401, "Unauthenticated")], eres=(401, err("AUTHENTICATION_REQUIRED", "Your session has expired. Sign in again.")),
   rules=["Members see the policy read-only so they understand why reminders happen."])

ep(domain="Rules and Alerts", m="PUT", p="/api/v1/rules/follow-up-policy", t="Replace follow-up policy",
   purpose="Save a new policy version.",
   perm="rules.manage", hdr=AUTH_V, params="None",
   idem="expected_version required.", audit="rules.policy_changed", event="rules.policy_changed", worker="New leads use the new version; open leads keep their version until their next timer step.",
   req={"expected_version": 3, "assignment": {"mode": "fixed_owner", "owner_id": "usr_01J9W8H2KD"}, "first_response": {"target_minutes": 10, "business_hours_only": True}, "follow_up": {"attempt_intervals_minutes": [60, 1440], "max_attempts": 3}, "escalation": {"after_overdue_minutes": 20, "notify": ["owners", "managers"], "repeat": False}, "unassigned_escalation_minutes": 10},
   code=200,
   res=ok({"version": 4, "active_from": "2026-10-14T15:42:11Z", "applies_to": "new leads and next timer step of open leads"}, "Follow-up rules saved (version 4)."),
   errs=[(200, "Saved"), (400, "Schema violation"), (403, "Not permitted"), (409, "Stale version")],
   eres=(400, err("VALIDATION_FAILED", "First response target must be between 5 and 1440 minutes.", details={"fields": {"first_response.target_minutes": "5-1440"}})),
   rules=["Strict schema: unknown keys rejected; no expressions, scripts or URLs.", "Bounds: target 5-1440 min, max 6 attempts, escalation 5-1440 min."])

ep(domain="Rules and Alerts", m="POST", p="/api/v1/rules/follow-up-policy/preview", t="Preview due times",
   purpose="Show when a lead arriving at a given moment would be due and escalated, before saving.",
   perm="rules.manage", hdr=AUTH_V, params="None",
   idem="Read-only computation; no writes.", audit="None.", event="None.", worker="None.",
   req={"policy": {"first_response": {"target_minutes": 15, "business_hours_only": True}, "escalation": {"after_overdue_minutes": 30}}, "arrival_local": "2026-10-16T17:55"},
   code=200,
   res=ok({"arrival_local": "Fri Oct 16, 5:55 PM CDT", "business_hours_version": 3, "business_hours_status": "closes 6:00 PM; Saturday closed",
           "first_response_due_local": "Mon Oct 19, 8:10 AM CDT",
           "explanation": "5 business minutes remain Friday; the remaining 10 minutes start at Monday 8:00 AM opening.",
           "escalation_at_local": "Mon Oct 19, 8:40 AM CDT"}),
   errs=[(200, "Success"), (400, "Invalid policy or time")],
   eres=(400, err("LOCAL_TIME_IN_DST_GAP", "That local time does not exist because clocks move forward. Choose another time.", details={"arrival_local": "2027-03-14T02:30"})),
   rules=["Uses exactly the same calculator as production timers."])

ep(domain="Rules and Alerts", m="GET", p="/api/v1/alerts", t="List my alerts",
   purpose="In-app reminders and escalations for the current user.",
   perm="leads.read", hdr=AUTH, params="state (open|acknowledged|all), cursor, limit",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"items": [
       {"id": "alr_01J9XH3B9D", "kind": "escalation", "lead_id": "lead_01J9X3M8ZP", "lead_name": "Dana Morales", "text": "Overdue 30 min - owner Chris Patel", "created_at": "2026-10-14T16:27:10Z",
        "my_deliveries": [{"channel": "in_app", "state": "delivered"}, {"channel": "email", "state": "accepted"}], "acknowledged": False}],
       "unread": 1, "next_cursor": None}),
   errs=[(200, "Success"), (401, "Unauthenticated")], eres=(401, err("AUTHENTICATION_REQUIRED", "Your session has expired. Sign in again.")),
   rules=["Alerts for leads the user can no longer see are hidden."])

ep(domain="Rules and Alerts", m="POST", p="/api/v1/alerts/{alertId}/acknowledge", t="Acknowledge alert",
   purpose="Mark an alert as seen; does not change the lead.",
   perm="Alert recipient", hdr=AUTH_W, params="alertId",
   idem="Idempotent: repeat returns the same acknowledgement.", audit="alert.acknowledged", event="None.", worker="None.",
   req={}, code=200,
   res=ok({"id": "alr_01J9XH3B9D", "acknowledged_by": "usr_01J9W2T4AA", "acknowledged_at": "2026-10-14T16:29:40Z", "lead_still_overdue": True}, "Alert acknowledged. The lead is still overdue."),
   errs=[(200, "Acknowledged"), (404, "Not your alert")],
   eres=(404, err("NOT_FOUND", "Alert not found.")),
   rules=["Acknowledgement is recorded per recipient on their delivery rows; other recipients still see the alert.", "Acknowledging never cancels the lead's timers; only handling the lead does.", "Allowed in every subscription state (control operation)."])

ep(domain="Rules and Alerts", m="PUT", p="/api/v1/me/notification-preferences", t="Set notification preferences",
   purpose="Choose alert channels and a personal quiet window.",
   perm="Authenticated member", hdr=AUTH_V, params="None",
   idem="PUT replaces preferences.", audit="member.notification_prefs_changed", event="None.", worker="None.",
   req={"channels": {"in_app": True, "email": True, "sms": False}, "escalations_always_email": True}, code=200,
   res=ok({"channels": {"in_app": True, "email": True, "sms": False}, "escalations_always_email": True, "sms_available": False}, "Preferences saved."),
   errs=[(200, "Saved"), (400, "Invalid channel"), (422, "SMS not enabled for this organization")],
   eres=(422, err("CHANNEL_NOT_AVAILABLE", "Text-message alerts are not enabled for your organization yet.")),
   rules=["In-app cannot be turned off for escalations; at least one channel stays active for managers."])

# ------------------------------------------------------------------ Dashboard
ep(domain="Owner Dashboard", m="GET", p="/api/v1/dashboard/summary", t="Owner dashboard summary",
   purpose="Factual counts for a date range: leads, first-action time, overdue and outcomes.",
   perm="dashboard.read", hdr=AUTH, params="from, to (local dates), source_id (optional)",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"range": {"from": "2026-10-01", "to": "2026-10-14", "time_zone": "America/Chicago"},
           "leads": {"received": 52, "test_excluded": 1, "by_source": [{"source": "Website contact form", "count": 38}, {"source": "Office phone line", "count": 11}, {"source": "Manual entry", "count": 3}]},
           "first_action": {"median_minutes": 11, "p90_minutes": 46, "within_target_pct": 79.0, "no_action_yet": 2},
           "unattended": {"overdue_now": 3, "unassigned_now": 2, "escalations_sent": 6},
           "outcomes": {"contacted": 31, "won": 9, "lost": 7, "spam": 2, "open": 3},
           "definitions": {"cohort": "leads created in range, excluding is_test, spam and merged", "first_action": "first call/text/email/visit activity (self-reported); notes and status changes excluded", "within_target_pct": "cohort leads whose first action was at or before due_at / cohort leads whose due_at has passed", "time_basis": "business minutes"}}),
   errs=[(200, "Success"), (400, "Range over 366 days"), (403, "Not permitted")],
   eres=(403, err("AUTHORIZATION_DENIED", "Only owners and managers can view the dashboard.")),
   rules=["No revenue, ROI or 'recovered' estimates are calculated or shown.", "Business-hours-adjusted first-action time is labelled as such."])

ep(domain="Owner Dashboard", m="GET", p="/api/v1/dashboard/exceptions", t="Unresolved exceptions",
   purpose="What a manager must fix: overdue/unassigned leads, failed alerts, failing sources, billing issues.",
   perm="dashboard.read", hdr=AUTH, params="cursor, limit",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"items": [
       {"type": "escalation_not_delivered", "lead_id": "lead_01J9W9P1XY", "alert_id": "alr_01J9XG0Z5W", "text": "Escalation email to Chris Patel bounced (in-app delivered)", "since": "2026-10-14T15:00:30Z", "action": "Check Chris's email address"},
       {"type": "source_failing", "source_id": "src_01J9Y0C1RT", "text": "Office phone line: 3 signature failures", "since": "2026-10-14T14:01:12Z", "action": "Rotate or re-enter the signing secret"},
       {"type": "lead_overdue", "lead_id": "lead_01J9W9P1XY", "text": "Greg Hall overdue 72 min (Maria Lopez)", "since": "2026-10-14T14:30:00Z", "action": "Reassign or call"}],
       "next_cursor": None}),
   errs=[(200, "Success"), (403, "Not permitted")],
   eres=(403, err("AUTHORIZATION_DENIED", "Only owners and managers can view exceptions.")),
   rules=["Each exception has a concrete next action; resolved exceptions disappear automatically."])

ep(domain="Owner Dashboard", m="GET", p="/api/v1/dashboard/source-health", t="Source health",
   purpose="Per-source delivery counts and silence detection for the last 7 days.",
   perm="dashboard.read", hdr=AUTH, params="None",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"items": [
       {"source_id": "src_01J9X3K6Q8", "name": "Website contact form", "status": "verified", "last_event_at": "2026-10-14T15:42:10Z", "last_7d": {"accepted": 31, "duplicate": 4, "rejected": 0}, "silence_alert": False},
       {"source_id": "src_01J9Y0C1RT", "name": "Office phone line", "status": "failing", "last_event_at": "2026-10-13T21:10:02Z", "last_7d": {"accepted": 11, "duplicate": 0, "rejected": 3}, "silence_alert": False}]}),
   errs=[(200, "Success"), (403, "Not permitted")],
   eres=(403, err("AUTHORIZATION_DENIED", "Only owners and managers can view source health.")),
   rules=["Silence alert triggers when a verified source sends nothing for longer than its configured window (default 72 business hours)."])

# ------------------------------------------------------------------ Billing
ep(domain="Subscription and Billing", m="GET", p="/api/v1/billing/plans", t="List plans",
   purpose="Plain-language plan list with limits and prices.",
   perm="Any member", hdr=AUTH, params="None",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"currency": "USD", "status": "draft_pending_validation", "items": [
       {"plan_id": "starter", "name": "Starter", "price_monthly": None, "limits": {"members": 3, "sources": 1, "leads_per_month": 200}},
       {"plan_id": "team", "name": "Team", "price_monthly": None, "limits": {"members": 10, "sources": 3, "leads_per_month": 1000}}],
       "note": "Prices are set by leadership within the USD 50-200 range before publication."}),
   errs=[(200, "Success"), (401, "Unauthenticated")], eres=(401, err("AUTHENTICATION_REQUIRED", "Your session has expired. Sign in again.")),
   rules=["Prices come from configuration approved by leadership; this document does not set them.", "While `status` is draft, the UI shows 'Contact us' instead of a price."])

ep(domain="Subscription and Billing", m="GET", p="/api/v1/billing/subscription", t="Read subscription",
   purpose="Plan, trial or invoice state, usage against limits, cancellation and export options.",
   perm="Any member (owners see payment details)", hdr=AUTH, params="None",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"state": "trialing", "plan_id": "team", "trial": {"started_at": "2026-10-10T18:03:44Z", "ends_at": "2026-10-24T18:03:44Z", "card_on_file": False},
           "usage": {"members": 2, "sources": 2, "leads_this_month": 38}, "writable": True,
           "after_trial": "Your account becomes read-only. You can export your data at any time.", "payment_method": None}),
   errs=[(200, "Success"), (401, "Unauthenticated")], eres=(401, err("AUTHENTICATION_REQUIRED", "Your session has expired. Sign in again.")),
   rules=["`writable` is computed by the same entitlement guard used by write endpoints."])

ep(domain="Subscription and Billing", m="POST", p="/api/v1/billing/checkout", t="Start checkout (explicit authorization)",
   purpose="Owner starts payment for a selected plan; returns the provider's hosted checkout URL.",
   perm="billing.manage. INTEGRATION STATUS: BLOCKED until leadership selects the provider (INT-004)", hdr=AUTH_W, params="None",
   idem="Idempotency-Key required; one open checkout per org.", audit="billing.checkout_started", event="billing.checkout_started", worker="billing-reconcile.",
   req={"plan_id": "team", "confirm_plan_and_price": True, "return_url": "https://app.leadguard.io/settings/billing"}, code=201,
   res=ok({"checkout_id": "chk_01J9XJ8P4R", "provider": "selected_at_G0", "checkout_url": "https://checkout.provider.example/c/cs_7Hq2", "expires_at": "2026-10-14T16:12:11Z", "subscription_state": "trialing"}, "Continue on the secure payment page."),
   errs=[(201, "Checkout created"), (400, "Confirmation missing"), (403, "Owner only"), (409, "Checkout already open, or billing not configured (Release 1 default)"), (503, "Billing provider unavailable")],
   eres=(409, err("BILLING_NOT_CONFIGURED", "Online payment is not available yet. Contact us to arrange your plan.")),
   rules=["No charge happens in this call. The subscription becomes `active` only after a verified provider webhook confirms payment.",
          "Disabled until leadership selects the provider; the pilot uses the managed invoice path."])

ep(domain="Subscription and Billing", m="POST", p="/api/v1/billing/cancel", t="Cancel subscription",
   purpose="Owner cancels; access continues to period end, then read-only with export.",
   perm="billing.manage", hdr=AUTH_W, params="None",
   idem="Idempotency-Key required.", audit="billing.cancel_requested", event="billing.cancel_requested", worker="billing-reconcile.",
   req={"reason": "Too expensive", "confirm": True}, code=200,
   res=ok({"state": "active", "cancel_at_period_end": True, "access_until": "2026-11-10T00:00:00Z", "then": "read_only", "export_available": True}, "Cancellation scheduled. You keep full access until Nov 10, 2026."),
   errs=[(200, "Scheduled"), (400, "Confirmation missing"), (403, "Owner only"), (503, "Provider unavailable - cancellation queued")],
   eres=(400, err("CONFIRMATION_REQUIRED", "Confirm that you want to cancel.")),
   rules=["Cancellation is never hidden behind support contact.", "If the provider is down the request is stored and retried; the owner sees 'cancellation pending'."])

ep(domain="Subscription and Billing", m="POST", p="/webhooks/v1/billing/{provider}", t="Billing provider webhook",
   purpose="Receive subscription and payment events from the selected provider.",
   perm="Provider signature verified by the billing adapter. INTEGRATION STATUS: BLOCKED until provider selection (INT-004)", hdr="Provider signature header, Content-Type", params="provider",
   idem="Unique provider event ID in `billing_events`.", audit="billing.event_applied", event="billing.subscription_changed", worker="billing-reconcile on unknown ordering.",
   req={"_note": "LeadGuard normalized billing event (test double); the real provider event is mapped by the adapter in INT-004.", "id": "evt_3Pq9", "type": "subscription.updated", "data": {"subscription_id": "sub_9Ka", "status": "active", "current_period_end": 1794268800, "metadata": {"org_id": "org_01J9W1R9CD"}}},
   code=200,
   res={"received": True, "applied": True, "org_state": "active"},
   extra=[("Duplicate provider event", 200, {"received": True, "applied": False, "duplicate": True})],
   errs=[(200, "Received"), (400, "Unknown event type (stored, ignored)"), (401, "Signature invalid")],
   eres=(401, {"received": False, "error": "signature_invalid"}),
   rules=["The org is resolved from LeadGuard's stored provider customer ID, not from metadata alone.", "Out-of-order events are resolved by fetching the subscription from the provider before applying."])

ep(domain="Subscription and Billing", m="POST", p="/webhooks/v1/notifications/{provider}", t="Notification delivery webhook",
   purpose="Receive email/SMS delivery, bounce and complaint events.",
   perm="Provider signature. INTEGRATION STATUS: BLOCKED until the email provider is chosen (INT-003)", hdr="Provider signature header, Content-Type", params="provider",
   idem="Unique provider message event ID.", audit="None (operational).", event="alert.delivery_updated", worker="None.",
   req={"_note": "LeadGuard normalized delivery event (test double); provider payload and signature defined in INT-003 after provider selection.", "message_id": "msg_88ad", "event": "bounced", "at": "2026-10-14T15:00:30Z"},
   code=200,
   res={"received": True, "alert_id": "alr_01J9XG0Z5W", "channel": "email", "delivery_state": "failed"},
   errs=[(200, "Received"), (401, "Signature invalid")],
   eres=(401, {"received": False, "error": "signature_invalid"}),
   rules=["A bounce on an escalation creates a dashboard exception.", "Delivered state never moves back to sent."])

# ------------------------------------------------------------------ Export & support
ep(domain="Export and Support Access", m="POST", p="/api/v1/exports", t="Request data export",
   purpose="Full CSV export of leads, activities and alerts; available in every subscription state.",
   perm="exports.create (owner)", hdr=AUTH_W, params="None",
   idem="Idempotency-Key required; one running export per org.", audit="export.requested", event="export.requested", worker="export-builds.",
   req={"include": ["leads", "activities", "alerts"], "format": "csv_zip"}, code=202,
   res=ok({"export_id": "exp_01J9XK2M7V", "status": "queued", "poll_url": "/api/v1/exports/exp_01J9XK2M7V"}, "Export started. We will email you when it is ready."),
   errs=[(202, "Queued"), (403, "Owner only"), (409, "Export already running"), (429, "Max 5 exports per day")],
   eres=(409, err("EXPORT_IN_PROGRESS", "An export is already running.", details={"export_id": "exp_01J9XK0A1B"})),
   rules=["CSV cells beginning with = + - @ are prefixed to prevent spreadsheet formula injection."])

ep(domain="Export and Support Access", m="GET", p="/api/v1/exports/{exportId}", t="Export status and download",
   purpose="Poll export status; returns a short-lived download URL when ready.",
   perm="exports.create (owner)", hdr=AUTH, params="exportId",
   idem="Read-only.", audit="export.downloaded (when URL issued)", event="None.", worker="None.", req=None, code=200,
   res=ok({"export_id": "exp_01J9XK2M7V", "status": "ready", "rows": {"leads": 412, "activities": 1890, "alerts": 233},
           "download_url": "https://files.leadguard.io/exports/exp_01J9XK2M7V.zip?sig=...", "url_expires_at": "2026-10-14T15:57:11Z", "file_expires_at": "2026-10-15T15:42:11Z"}),
   errs=[(200, "Status returned"), (404, "Not found")],
   eres=(404, err("NOT_FOUND", "Export not found or expired.")),
   rules=["Signed URL valid 15 minutes; file deleted after 24 hours."])

ep(domain="Export and Support Access", m="GET", p="/api/v1/support-access/grants", t="List support access grants",
   purpose="Show the owner every past and current support access grant.",
   perm="support.grant (owner)", hdr=AUTH, params="None",
   idem="Read-only.", audit="None.", event="None.", worker="None.", req=None, code=200,
   res=ok({"items": [{"grant_id": "sag_01J9XL5N2E", "scope": "read_only", "reason": "Ticket #1042 - missing leads from form", "granted_by": "Chris Patel", "starts_at": "2026-10-14T15:00:00Z", "expires_at": "2026-10-14T19:00:00Z", "status": "active", "accesses": 3}]}),
   errs=[(200, "Success"), (403, "Owner only")],
   eres=(403, err("AUTHORIZATION_DENIED", "Only owners can manage support access.")),
   rules=["`accesses` counts support sessions under the grant; each is audited."])

ep(domain="Export and Support Access", m="POST", p="/api/v1/support-access/grants", t="Grant support access",
   purpose="Owner approves time-bound support access for a specific ticket.",
   perm="support.grant (owner)", hdr=AUTH_W, params="None",
   idem="Idempotency-Key required.", audit="support.access_granted", event="support.access_granted", worker="Expiry job.",
   req={"scope": "read_only", "duration_hours": 4, "reason": "Ticket #1042 - missing leads from form"}, code=201,
   res=ok({"grant_id": "sag_01J9XL5N2E", "scope": "read_only", "expires_at": "2026-10-14T19:42:11Z", "status": "active"}, "Support can view your account (read-only) for 4 hours."),
   errs=[(201, "Granted"), (400, "Duration over 72 hours"), (403, "Owner only")],
   eres=(400, err("VALIDATION_FAILED", "Support access can last at most 72 hours.")),
   rules=["Scopes: read_only (default) or read_write; read_write requires a second confirmation.", "Support staff are `users.kind = support_staff` accounts in a separate Clerk instance with MFA required. They call the same API with `X-Support-Grant-Id`; middleware checks `lg.active_support_grant()`, sets org context, forces read-only for `read_only` grants, and audits every request with the grant ID."])

ep(domain="Export and Support Access", m="POST", p="/api/v1/support-access/grants/{grantId}/revoke", t="Revoke support access",
   purpose="End a support grant immediately.",
   perm="support.grant (owner)", hdr=AUTH_W, params="grantId",
   idem="Idempotent.", audit="support.access_revoked", event="support.access_revoked", worker="None.",
   req={}, code=200,
   res=ok({"grant_id": "sag_01J9XL5N2E", "status": "revoked", "revoked_at": "2026-10-14T16:05:00Z"}, "Support access revoked."),
   errs=[(200, "Revoked"), (404, "Not found")],
   eres=(404, err("NOT_FOUND", "Grant not found.")),
   rules=["Active support sessions are terminated on the next request."])


# ------------------------------------------------------------------ rendering
import re, uuid, hashlib

ENT = {  # entitlement class per operation (Section 13.2)
 "Service health": "none", "Current user and memberships": "read", "Create organization": "bootstrap",
 "Read organization": "read", "Update organization": "setup", "Replace business hours": "setup",
 "List members": "read", "Invite member": "setup", "Accept invitation": "bootstrap", "Change member role": "control",
 "Deactivate member": "control", "List sources": "read", "Create source": "setup", "Read source and verification state": "read",
 "Start source verification": "setup", "Source delivery log": "read", "Rotate signing secret": "setup", "Disable source": "control",
 "Re-enable source": "setup", "Receive website form event": "ingest", "Receive call event (provider-neutral)": "ingest",
 "Needs Action inbox": "read", "Search and list leads": "read", "Create lead manually": "business_write", "Read lead": "read",
 "Update lead contact details": "business_write", "Assign or claim lead": "business_write", "Log contact attempt or note": "business_write",
 "Change lead status": "business_write", "Reschedule next action": "business_write", "Lead timeline": "read", "Merge duplicate lead": "business_write",
 "Read follow-up policy": "read", "Replace follow-up policy": "setup", "Preview due times": "read", "List my alerts": "read",
 "Acknowledge alert": "control", "Set notification preferences": "control", "Owner dashboard summary": "read",
 "Unresolved exceptions": "read", "Source health": "read", "List plans": "read", "Read subscription": "read",
 "Start checkout (explicit authorization)": "control", "Cancel subscription": "control", "Billing provider webhook": "provider",
 "Notification delivery webhook": "provider", "Request data export": "control", "Export status and download": "control",
 "List support access grants": "read", "Grant support access": "control", "Revoke support access": "control"}

ID_RE = re.compile(r'\b(org|usr|lead|src|sev|inv|act|alr|ver|chk|exp|sag)_[0-9A-Z]{10}\b')
def synth_uuid(m):
    h = bytearray(hashlib.sha256(m.group(0).encode()).digest()[:16])
    h[0:6] = (0x019A2B000000 + (int.from_bytes(h[0:6], 'big') % 0xFFFFFF)).to_bytes(6, 'big')  # time-ordered-looking prefix
    h[6] = (h[6] & 0x0F) | 0x70   # version 7
    h[8] = (h[8] & 0x3F) | 0x80   # RFC 4122 variant
    return str(uuid.UUID(bytes=bytes(h)))

def code_block(obj, ts=None):
    s = obj if isinstance(obj, str) else json.dumps(obj, indent=2, ensure_ascii=False)
    s = ID_RE.sub(synth_uuid, s)
    if ts:
        s = s.replace('"timestamp": "%s"' % TS, '"timestamp": "%s"' % ts)
    return "\n".join("    " + line for line in s.splitlines()) + "\n"

def tcell(s):
    return ID_RE.sub(synth_uuid, str(s)).replace("|", "\\|")

def api_id(i):
    return "API-%03d" % i

def render(first_section):
    out = []
    n = len(E)
    out.append(f"# {first_section}. Release 1 Endpoint Registry - {n} HTTP Operations\n")
    out.append("| ID | Method | Path | Purpose | Entitlement |\n|---------|--------|------------------------------------------------|------------------------------|------------|")
    for i, e in enumerate(E, 1):
        out.append(f"| {api_id(i)} | {e['m']} | {tcell(e['p'])} | {tcell(e['t'])} | {ENT[e['t']]} |")
    out.append("")
    out.append("::: callout-red\nEndpoint result rule\n\nEvery operation below shows its request, its success result and at least one error result in the exact envelope the API returns. All IDs, names, phone numbers and emails are synthetic. Examples are independent snapshots of the shared fixture in Section 18.4 unless a sequence is stated. Front-end and QA work from these examples; an endpoint is not done until its live responses match them.\n:::\n")
    sec = first_section
    domain = None
    for i, e in enumerate(E, 1):
        if e["domain"] != domain:
            domain = e["domain"]
            sec += 1
            out.append(f"# {sec}. {domain} Endpoint Contracts\n")
        ts = TS_OVERRIDE.get(e["t"])
        out.append(f"## {api_id(i)} {e['t']}\n")
        rows = [("Method", e["m"]), ("Path", e["p"]), ("Purpose", e["purpose"]), ("Permission", e["perm"]),
                ("Entitlement class", ENT[e["t"]] + " (Section 13.2)"),
                ("Headers", e["hdr"]), ("Path / query parameters", e["params"]),
                ("Idempotency / concurrency", e["idem"]), ("Audit", e["audit"]),
                ("Domain event", e["event"]), ("Worker / async", e["worker"])]
        out.append("| Item | Contract |\n|------------------------|--------------------------------------------------------|")
        for k, v in rows:
            out.append(f"| {k} | {tcell(v)} |")
        out.append("")
        if e["req"] is not None:
            out.append("Request example\n")
            out.append(code_block(e["req"]))
        out.append(f"Success result ({e['code']})\n")
        out.append(code_block(e["res"], ts))
        for label, code, body in e.get("extra", []):
            out.append(f"{label} ({code})\n")
            out.append(code_block(body, ts))
        ecode, ebody = e["eres"]
        out.append(f"Error result ({ecode})\n")
        out.append(code_block(ebody))
        out.append("| HTTP | Meaning |\n|------|------------------------------------------------|")
        for c, mng in e["errs"]:
            out.append(f"| {c} | {tcell(mng)} |")
        out.append("")
        for r in e["rules"]:
            out.append(f"-   {tcell(r)}\n")
    return "\n".join(out), sec, n

def all_examples():
    """Every example body, for machine validation (contracts/api-examples.json)."""
    items = []
    for i, e in enumerate(E, 1):
        ts = TS_OVERRIDE.get(e["t"])
        def norm(o):
            return json.loads(code_block(o, ts).replace("\n    ", "\n").strip()) if not isinstance(o, str) else o
        rec = {"id": api_id(i), "method": e["m"], "path": e["p"], "title": e["t"], "entitlement": ENT[e["t"]],
               "request": norm(e["req"]) if e["req"] is not None else None,
               "success": {"status": e["code"], "body": norm(e["res"])},
               "extra": [{"label": l, "status": c, "body": norm(b)} for l, c, b in e.get("extra", [])],
               "error": {"status": e["eres"][0], "body": norm(e["eres"][1])},
               "statuses": [c for c, _ in e["errs"]]}
        items.append(rec)
    return items

if __name__ == "__main__":
    md, last, n = render(int(sys.argv[1]))
    open(sys.argv[2], "w").write(md)
    if len(sys.argv) > 3:
        open(sys.argv[3], "w").write(json.dumps(all_examples(), indent=2))
    print(last, n)
