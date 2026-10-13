// End-to-end acceptance tests against a real PostgreSQL with the canonical schema, FORCE RLS and runtime roles.
// Covers E2E-01 (enquiry -> owner -> due time -> reminder -> escalation -> contact), SRC-01..09, ALR-01..04/06,
// BIL-04/06, SEC-01/07, idempotency R-IDEM-1..4, and export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { signV1 } from '@leadguard/domain';
import { createLocalStorage, noneEmailAdapter } from '@leadguard/adapters';
import { startHarness, bearer, idem, type Harness } from './helpers.ts';
import type { WorkerContext } from '../../worker/src/context.ts';
import { inlineDispatcher } from '../../worker/src/queues.ts';
import { sweep } from '../../worker/src/sweeper.ts';
import { publishOutbox } from '../../worker/src/outbox.ts';
import { processExport } from '../../worker/src/exports.ts';

let h: Harness;
let worker: WorkerContext;

const OWNER = bearer('user_owner', 'chris@acmeplumbing.com', 'Chris Patel');
const MEMBER = bearer('user_member', 'maria@acmeplumbing.com', 'Maria Lopez');
const OTHER = bearer('user_other', 'bea@otherco.example', 'Bea Other');
const SUPPORT = 'Bearer devsupport:staff_1:help@leadguard.io:Support Sam';

const state: Record<string, any> = {};

async function call(method: string, url: string, auth: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await h.app.inject({
    method: method as any, url,
    headers: { ...(auth ? { authorization: auth } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

async function ingest(key: string, payload: Record<string, unknown>, secret: string, opts: { forge?: boolean; ts?: number } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = signV1(opts.forge ? 'whsec_wrong' : secret, ts, raw);
  const res = await h.app.inject({
    method: 'POST', url: `/ingest/v1/forms/${key}`,
    headers: { 'content-type': 'application/json', 'x-leadguard-timestamp': ts, 'x-leadguard-signature': sig }, payload: raw,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/** Make every pending timer of a lead due now (fake clock for the worker). */
async function makeDue(leadId: string, kind?: string) {
  await h.admin.query(`UPDATE lg.leads SET due_at = now() - interval '1 second' WHERE id = $1 AND due_at IS NOT NULL`, [leadId]);
  await h.admin.query(`UPDATE lg.lead_timers SET due_at = now() - interval '1 second' WHERE lead_id = $1 AND state = 'pending' ${kind ? 'AND kind = $2' : ''}`, kind ? [leadId, kind] : [leadId]);
}

before(async () => {
  h = await startHarness();
  worker = {
    config: { appUrl: 'http://app.test' } as any,
    app: h.deps.pool, scanner: h.scanner, email: noneEmailAdapter,
    storage: createLocalStorage({ dir: h.exportDir, publicBaseUrl: 'http://api.test', signingSecret: 'test-cursor' }),
    dispatcher: inlineDispatcher(() => worker),
    inFlightTimers: new Set(),
  };
});

after(async () => { await h?.stop(); });

test('API-001 health is 200 degraded without Redis', async () => {
  const r = await call('GET', '/internal/v1/health', null);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'degraded');
  assert.equal(r.body.checks.postgres, 'ok');
});

test('API-002 requires a session; a new user has no organizations', async () => {
  assert.equal((await call('GET', '/api/v1/me', null)).status, 401);
  const r = await call('GET', '/api/v1/me', OWNER);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.organizations, []);
  assert.equal(r.body.meta.api_version, 'v1');
});

test('API-003 create organization, idempotent replay and key reuse', async () => {
  const body = { name: 'Acme Plumbing', time_zone: 'America/Chicago', country: 'US' };
  const key = idem();
  const r = await call('POST', '/api/v1/organizations', OWNER, body, { 'idempotency-key': key });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.subscription.state, 'setup_pending');
  state.orgId = r.body.data.org.id;
  const replay = await call('POST', '/api/v1/organizations', OWNER, body, { 'idempotency-key': key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.org.id, state.orgId);
  const reused = await call('POST', '/api/v1/organizations', OWNER, { ...body, name: 'Other' }, { 'idempotency-key': key });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  const bad = await call('POST', '/api/v1/organizations', OWNER, { ...body, time_zone: 'Mars/Base' }, { 'idempotency-key': idem() });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.fields.time_zone);
  const me = await call('GET', '/api/v1/me', OWNER);
  assert.equal(me.body.data.active_org.role, 'owner');
  assert.equal(me.body.data.subscription_state, 'setup_pending');
});

test('BIL-06 setup_pending: business_write rejected 423, setup allowed', async () => {
  const r = await call('POST', '/api/v1/leads', OWNER, { name: 'Kim', phone: '512-555-0177' }, { 'idempotency-key': idem() });
  assert.equal(r.status, 423);
  assert.equal(r.body.error.code, 'SUBSCRIPTION_INACTIVE');
});

test('API-013 create source: secret shown once, replay redacted (R-IDEM-3)', async () => {
  const key = idem();
  const body = { type: 'web_form_webhook', name: 'Website contact form', field_mapping: { name: 'full_name', message: 'comments' } };
  const r = await call('POST', '/api/v1/sources', OWNER, body, { 'idempotency-key': key });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.data.signing_secret.startsWith('whsec_'));
  state.sourceId = r.body.data.source.id;
  state.secret = r.body.data.signing_secret;
  state.sourceKey = r.body.data.endpoint_url.split('/').pop();
  const replay = await call('POST', '/api/v1/sources', OWNER, body, { 'idempotency-key': key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.signing_secret, null);
  assert.equal(replay.body.data.secret_available, false);
  const stored = await h.admin.query(`SELECT response_body::text FROM lg.idempotency_keys WHERE route = '/api/v1/sources'`);
  assert.ok(!stored.rows[0].response_body.includes(state.secret), 'plaintext secret stored in idempotency_keys');
});

test('SRC-09 event to a draft source without a window -> 409 SOURCE_NOT_VERIFIED', async () => {
  const r = await ingest(state.sourceKey, { entry_id: 'x1', email: 'a@example.com' }, state.secret);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'SOURCE_NOT_VERIFIED');
});

test('SRC-03 verification: test event verifies the source and starts the trial', async () => {
  const before_ = await call('GET', `/api/v1/sources/${state.sourceId}`, OWNER);
  assert.notEqual(before_.body.data.status, 'verified');
  const w = await call('POST', `/api/v1/sources/${state.sourceId}/test-event`, OWNER, { window_minutes: 15 }, { 'idempotency-key': idem() });
  assert.equal(w.status, 202);
  assert.equal(w.body.data.status, 'testing');
  const forged = await ingest(state.sourceKey, { entry_id: 'test_1', email: 'test@example.com' }, state.secret, { forge: true });
  assert.equal(forged.status, 401);
  const mid = await call('GET', `/api/v1/sources/${state.sourceId}`, OWNER);
  assert.equal(mid.body.data.verification.steps[1].state, 'failed');
  const ok = await ingest(state.sourceKey, { entry_id: 'test_1', full_name: 'Test Person', email: 'test@example.com' }, state.secret);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const after_ = await call('GET', `/api/v1/sources/${state.sourceId}`, OWNER);
  assert.equal(after_.body.data.status, 'verified');
  assert.ok(after_.body.data.verification.steps.every((s: any) => s.state === 'passed'));
  const me = await call('GET', '/api/v1/me', OWNER);
  assert.equal(me.body.data.subscription_state, 'trialing');
  const lead = await call('GET', `/api/v1/leads/${ok.body.lead_id}`, OWNER);
  assert.equal(lead.body.data.is_test, true);
});

test('Invite and accept: member joins (API-008, API-009)', async () => {
  const inv = await call('POST', '/api/v1/invitations', OWNER, { email: 'maria@acmeplumbing.com', role: 'member' }, { 'idempotency-key': idem() });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.data.email_delivery, 'not_configured');
  const token = inv.body.data.invite_url.split('#')[1];
  const wrong = await call('POST', '/api/v1/invitations/accept', OTHER, { token });
  assert.equal(wrong.status, 403);
  const acc = await call('POST', '/api/v1/invitations/accept', MEMBER, { token });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.data.membership.role, 'member');
  const again = await call('POST', '/api/v1/invitations/accept', MEMBER, { token });
  assert.equal(again.status, 200);
  const members = await call('GET', '/api/v1/members', OWNER);
  assert.equal(members.body.data.items.filter((m: any) => m.status === 'active').length, 2);
  state.memberId = members.body.data.items.find((m: any) => m.role === 'member').user_id;
  state.ownerId = members.body.data.items.find((m: any) => m.role === 'owner').user_id;
});

test('SRC-01 / SRC-02 / SRC-04: valid, forged and stale events', async () => {
  const payload = { entry_id: 'wpf_entry_8841', submitted_at: new Date().toISOString(), full_name: 'Dana Morales', email: 'dana.morales@example.com', phone: '(512) 555-0142', comments: 'Water heater leaking', service: 'plumbing', zip: '78704' };
  const forged = await ingest(state.sourceKey, payload, state.secret, { forge: true });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.error.code, 'SIGNATURE_INVALID');
  const stale = await ingest(state.sourceKey, payload, state.secret, { ts: Math.floor(Date.now() / 1000) - 301 });
  assert.equal(stale.status, 401);
  const ok = await ingest(state.sourceKey, payload, state.secret);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.outcome, 'lead_created');
  assert.equal(ok.body.duplicate, false);
  state.danaId = ok.body.lead_id;
  state.danaPayload = payload;
  const leads = await h.admin.query('SELECT count(*)::int n FROM lg.leads WHERE email_norm = $1', ['dana.morales@example.com']);
  assert.equal(leads.rows[0].n, 1);
});

test('SRC-05 same event delivered 5 times concurrently -> one lead, five attempts', async () => {
  const payload = { entry_id: 'concurrent_1', full_name: 'Greg Hall', email: 'greg@example.com', phone: '512-555-0101' };
  const results = await Promise.all(Array.from({ length: 5 }, () => ingest(state.sourceKey, payload, state.secret)));
  const leadIds = new Set(results.map(r => r.body.lead_id));
  assert.equal(leadIds.size, 1);
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.body.duplicate).length, 4);
  const ev = await h.admin.query(`SELECT count(*)::int n FROM lg.source_events WHERE dedupe_key = 'form:concurrent_1'`);
  assert.equal(ev.rows[0].n, 1);
  const att = await h.admin.query(`SELECT count(*)::int n FROM lg.delivery_attempts a JOIN lg.source_events e ON e.id = a.source_event_id WHERE e.dedupe_key = 'form:concurrent_1'`);
  assert.equal(att.rows[0].n, 5);
  const timers = await h.admin.query(`SELECT count(*)::int n FROM lg.lead_timers WHERE lead_id = $1`, [[...leadIds][0]]);
  assert.equal(timers.rows[0].n, 1);
  state.gregId = [...leadIds][0];
});

test('Repeat enquiry links to the open lead (lead_linked)', async () => {
  const r = await ingest(state.sourceKey, { entry_id: 'wpf_entry_9000', full_name: 'Dana Morales', email: 'dana.morales@example.com' }, state.secret);
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'lead_linked');
  assert.equal(r.body.lead_id, state.danaId);
});

test('SEC-01 another organization cannot see the lead (404, not 403)', async () => {
  const org = await call('POST', '/api/v1/organizations', OTHER, { name: 'Other Co', time_zone: 'America/New_York' }, { 'idempotency-key': idem() });
  assert.equal(org.status, 201);
  const r = await call('GET', `/api/v1/leads/${state.danaId}`, OTHER);
  assert.equal(r.status, 404);
  const search = await call('POST', '/api/v1/leads/search', OTHER, { query: 'morales' });
  assert.equal(search.body.data.items.length, 0);
});

test('Inbox shows owner, due time and next action (API-022)', async () => {
  const r = await call('GET', '/api/v1/inbox?view=team', OWNER);
  assert.equal(r.status, 200);
  const all = [...r.body.data.sections.overdue, ...r.body.data.sections.due_soon, ...r.body.data.sections.unassigned];
  const dana = all.find((x: any) => x.id === state.danaId);
  assert.ok(dana, 'lead in inbox');
  assert.equal(dana.next_action, 'First call');
  assert.equal(r.body.data.counts.due_soon + r.body.data.counts.overdue + r.body.data.counts.unassigned, all.length);
});

test('Member visibility: members see own + unassigned only', async () => {
  const lead = await call('GET', `/api/v1/leads/${state.danaId}`, OWNER);
  const ownerOfDana = lead.body.data.owner?.user_id;
  const asMember = await call('GET', `/api/v1/leads/${state.danaId}`, MEMBER);
  assert.equal(asMember.status, ownerOfDana === state.memberId || !ownerOfDana ? 200 : 404);
});

test('ALR-01..ALR-03 overdue -> one reminder; replay -> no second alert; escalation follows', async () => {
  // Make Dana owned by the owner so the reminder recipient is deterministic.
  const cur = await call('GET', `/api/v1/leads/${state.danaId}`, OWNER);
  if (cur.body.data.owner?.user_id !== state.ownerId) {
    const a = await call('POST', `/api/v1/leads/${state.danaId}/assign`, OWNER, { expected_version: cur.body.data.version, owner_id: 'me' }, { 'idempotency-key': idem() });
    assert.equal(a.status, 200, JSON.stringify(a.body));
  }
  await makeDue(state.danaId, 'first_response_due');
  await sweep(worker);
  const alerts = await h.admin.query(`SELECT a.id, a.kind, t.kind AS timer_kind FROM lg.alerts a JOIN lg.lead_timers t ON t.id = a.timer_id WHERE a.lead_id = $1`, [state.danaId]);
  assert.equal(alerts.rows.length, 1);
  assert.equal(alerts.rows[0].kind, 'reminder');
  const deliveries = await h.admin.query(`SELECT channel, state FROM lg.alert_deliveries WHERE alert_id = $1`, [alerts.rows[0].id]);
  assert.deepEqual(deliveries.rows, [{ channel: 'in_app', state: 'delivered' }]);
  // Replaying the sweep must not create a second alert (DB-11 / ALR-03).
  // Simulate a replayed job: put the fired occurrence back to pending (the alert for it already exists).
  await h.admin.query(`UPDATE lg.lead_timers SET state = 'pending', claimed_until = NULL, due_at = now() - interval '1 second' WHERE id = (SELECT timer_id FROM lg.alerts WHERE id = $1)`, [alerts.rows[0].id]);
  await sweep(worker);
  const again = await h.admin.query(`SELECT count(*)::int n FROM lg.alerts WHERE lead_id = $1 AND kind = 'reminder'`, [state.danaId]);
  assert.equal(again.rows[0].n, 1);
  const esc = await h.admin.query(`SELECT count(*)::int n FROM lg.lead_timers WHERE lead_id = $1 AND kind = 'escalation' AND state = 'pending'`, [state.danaId]);
  assert.equal(esc.rows[0].n, 1);
  await makeDue(state.danaId, 'escalation');
  await sweep(worker);
  const escAlert = await h.admin.query(`SELECT count(*)::int n FROM lg.alerts WHERE lead_id = $1 AND kind = 'escalation'`, [state.danaId]);
  assert.equal(escAlert.rows[0].n, 1);
  const mine = await call('GET', '/api/v1/alerts', OWNER);
  assert.ok(mine.body.data.items.length >= 1);
  const ack = await call('POST', `/api/v1/alerts/${mine.body.data.items[0].id}/acknowledge`, OWNER, {}, { 'idempotency-key': idem() });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.data.lead_still_overdue, true);
});

test('AUD-02 timeline names timer kind, cycle and policy version', async () => {
  const r = await call('GET', `/api/v1/leads/${state.danaId}/timeline`, OWNER);
  assert.equal(r.status, 200);
  const reminder = r.body.data.items.find((i: any) => i.type === 'reminder');
  assert.match(reminder.text, /policy v1, first_response_due cycle \d+\)/);
  assert.ok(r.body.data.items.some((i: any) => i.type === 'event_received'));
});

test('API-028 no_answer -> attempted + follow-up; reached -> contacted, timers cancelled (ALR-04)', async () => {
  let lead = (await call('GET', `/api/v1/leads/${state.danaId}`, OWNER)).body.data;
  const future = await call('POST', `/api/v1/leads/${state.danaId}/activities`, OWNER,
    { expected_version: lead.version, type: 'call', outcome: 'no_answer', occurred_at: new Date(Date.now() + 3600_000).toISOString() }, { 'idempotency-key': idem() });
  assert.equal(future.status, 400);
  const a1 = await call('POST', `/api/v1/leads/${state.danaId}/activities`, OWNER, { expected_version: lead.version, type: 'call', outcome: 'no_answer', note: 'Left voicemail' }, { 'idempotency-key': idem() });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.data.lead.status, 'attempted');
  assert.deepEqual(a1.body.data.timers.created, ['follow_up_due']);
  const stale = await call('POST', `/api/v1/leads/${state.danaId}/activities`, OWNER, { expected_version: lead.version, type: 'call', outcome: 'reached' }, { 'idempotency-key': idem() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  lead = (await call('GET', `/api/v1/leads/${state.danaId}`, OWNER)).body.data;
  const a2 = await call('POST', `/api/v1/leads/${state.danaId}/activities`, OWNER, { expected_version: lead.version, type: 'call', outcome: 'reached' }, { 'idempotency-key': idem() });
  assert.equal(a2.status, 201);
  assert.equal(a2.body.data.lead.status, 'contacted');
  const pending = await h.admin.query(`SELECT count(*)::int n FROM lg.lead_timers WHERE lead_id = $1 AND state IN ('pending','claimed')`, [state.danaId]);
  assert.equal(pending.rows[0].n, 0);
});

test('API-029 transitions follow Section 30.1; reopen creates a new cycle (ALR-06)', async () => {
  let lead = (await call('GET', `/api/v1/leads/${state.gregId}`, OWNER)).body.data;
  const bad = await call('POST', `/api/v1/leads/${state.gregId}/status`, OWNER, { expected_version: lead.version, to_status: 'won' }, { 'idempotency-key': idem() });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.error.details.allowed, ['attempted', 'contacted', 'lost', 'spam']);
  const noReason = await call('POST', `/api/v1/leads/${state.gregId}/status`, OWNER, { expected_version: lead.version, to_status: 'lost' }, { 'idempotency-key': idem() });
  assert.equal(noReason.status, 422);
  const lost = await call('POST', `/api/v1/leads/${state.gregId}/status`, OWNER, { expected_version: lead.version, to_status: 'lost', reason: 'Chose competitor' }, { 'idempotency-key': idem() });
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  lead = (await call('GET', `/api/v1/leads/${state.gregId}`, OWNER)).body.data;
  const reopen = await call('POST', `/api/v1/leads/${state.gregId}/status`, OWNER, { expected_version: lead.version, to_status: 'attempted', reason: 'Called back' }, { 'idempotency-key': idem() });
  assert.equal(reopen.status, 200, JSON.stringify(reopen.body));
  const t = await h.admin.query(`SELECT count(*)::int n FROM lg.lead_timers WHERE lead_id = $1 AND state = 'pending'`, [state.gregId]);
  assert.ok(t.rows[0].n >= 1);
});

test('API-030 snooze rejects ambiguous DST time and accepts a normal one', async () => {
  const lead = (await call('GET', `/api/v1/leads/${state.gregId}`, OWNER)).body.data;
  const amb = await call('POST', `/api/v1/leads/${state.gregId}/snooze`, OWNER, { expected_version: lead.version, due_at_local: '2026-11-01T01:30', reason: 'x' }, { 'idempotency-key': idem() });
  assert.equal(amb.status, 400);
  assert.ok(['LOCAL_TIME_AMBIGUOUS', 'VALIDATION_FAILED'].includes(amb.body.error.code));
  const d = new Date(Date.now() + 2 * 86_400_000);
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) + 'T10:00';
  const ok = await call('POST', `/api/v1/leads/${state.gregId}/snooze`, OWNER, { expected_version: lead.version, due_at_local: local, reason: 'Customer asked for later' }, { 'idempotency-key': idem() });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('Two members claiming at once: exactly one succeeds (API-027)', async () => {
  await h.admin.query(`UPDATE lg.follow_up_policies SET policy = jsonb_set(policy, '{assignment}', '{"mode":"unassigned_queue"}') WHERE is_current`);
  const r = await ingest(state.sourceKey, { entry_id: 'unassigned_1', full_name: 'Una Signed', phone: '512-555-0199' }, state.secret);
  assert.equal(r.status, 201);
  const lead = (await call('GET', `/api/v1/leads/${r.body.lead_id}`, MEMBER)).body.data;
  assert.equal(lead.owner, null);
  const [a, b] = await Promise.all([
    call('POST', `/api/v1/leads/${lead.id}/assign`, MEMBER, { expected_version: lead.version, owner_id: 'me' }, { 'idempotency-key': idem() }),
    call('POST', `/api/v1/leads/${lead.id}/assign`, OWNER, { expected_version: lead.version, owner_id: 'me' }, { 'idempotency-key': idem() }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
});

test('SEC-07 support access only through an active grant; read-only enforced; revoke ends it', async () => {
  const none = await call('GET', '/api/v1/inbox', SUPPORT, undefined, { 'x-support-grant-id': '019a2bb3-4e70-7a82-8665-fe27558df923' });
  assert.equal(none.status, 403);
  const g = await call('POST', '/api/v1/support-access/grants', OWNER, { scope: 'read_only', duration_hours: 4, reason: 'Ticket #1042' }, { 'idempotency-key': idem() });
  assert.equal(g.status, 201);
  const hdr = { 'x-support-grant-id': g.body.data.grant_id };
  const read = await call('GET', `/api/v1/leads/${state.danaId}`, SUPPORT, undefined, hdr);
  assert.equal(read.status, 200);
  const write = await call('POST', '/api/v1/leads', SUPPORT, { name: 'X', phone: '5125550100' }, { ...hdr, 'idempotency-key': idem() });
  assert.equal(write.status, 403);
  const list = await call('GET', '/api/v1/support-access/grants', OWNER);
  assert.ok(list.body.data.items[0].accesses >= 1);
  const rev = await call('POST', `/api/v1/support-access/grants/${g.body.data.grant_id}/revoke`, OWNER, {}, { 'idempotency-key': idem() });
  assert.equal(rev.status, 200);
  const after_ = await call('GET', `/api/v1/leads/${state.danaId}`, SUPPORT, undefined, hdr);
  assert.equal(after_.status, 403);
  const denied = await h.admin.query(`SELECT count(*)::int n FROM lg.audit_events WHERE action = 'support.access_denied'`);
  assert.ok(denied.rows[0].n >= 1);
});

test('Dashboard summary, exceptions and source health (API-039..041); members denied', async () => {
  const s = await call('GET', '/api/v1/dashboard/summary', OWNER);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.data.leads.test_excluded, 1);
  assert.equal(s.body.data.definitions.time_basis, 'business minutes');
  assert.equal((await call('GET', '/api/v1/dashboard/exceptions', OWNER)).status, 200);
  assert.equal((await call('GET', '/api/v1/dashboard/source-health', OWNER)).status, 200);
  assert.equal((await call('GET', '/api/v1/dashboard/summary', MEMBER)).status, 403);
});

test('Export: queued -> built by worker -> signed download (API-048/049)', async () => {
  const e = await call('POST', '/api/v1/exports', OWNER, { include: ['leads', 'activities', 'alerts'], format: 'csv_zip' }, { 'idempotency-key': idem() });
  assert.equal(e.status, 202, JSON.stringify(e.body));
  const dup = await call('POST', '/api/v1/exports', OWNER, {}, { 'idempotency-key': idem() });
  assert.equal(dup.status, 409);
  assert.equal(await processExport(worker, state.orgId, e.body.data.export_id), 'ready');
  const g = await call('GET', `/api/v1/exports/${e.body.data.export_id}`, OWNER);
  assert.equal(g.body.data.status, 'ready');
  const url = new URL(g.body.data.download_url);
  const file = await h.app.inject({ method: 'GET', url: url.pathname + url.search });
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers['content-type'], 'application/zip');
});

test('BIL-04 read_only rejects business writes, setup and ingest; control and export still work', async () => {
  await h.admin.query(`UPDATE lg.subscriptions SET state = 'read_only' WHERE org_id = $1`, [state.orgId]);
  const w = await call('POST', '/api/v1/leads', OWNER, { name: 'Kim', phone: '512-555-0177' }, { 'idempotency-key': idem() });
  assert.equal(w.status, 423);
  const setup = await call('POST', '/api/v1/invitations', OWNER, { email: 'sam@acmeplumbing.com', role: 'member' }, { 'idempotency-key': idem() });
  assert.equal(setup.status, 423);
  const ing = await ingest(state.sourceKey, { entry_id: 'ro_1', email: 'ro@example.com' }, state.secret);
  assert.equal(ing.status, 423);
  const disable = await call('POST', `/api/v1/sources/${state.sourceId}/disable`, OWNER, { reason: 'test' }, { 'idempotency-key': idem() });
  assert.equal(disable.status, 200);
  const sub = await call('GET', '/api/v1/billing/subscription', OWNER);
  assert.equal(sub.body.data.writable, false);
  const checkout = await call('POST', '/api/v1/billing/checkout', OWNER, { plan_id: 'team' }, { 'idempotency-key': idem() });
  assert.equal(checkout.status, 400);
  const checkout2 = await call('POST', '/api/v1/billing/checkout', OWNER, { plan_id: 'team', confirm_plan_and_price: true }, { 'idempotency-key': idem() });
  assert.equal(checkout2.status, 409);
  assert.equal(checkout2.body.error.code, 'BILLING_NOT_CONFIGURED');
});

test('SRC-07 disabled source rejects with 410; re-enable returns to testing', async () => {
  await h.admin.query(`UPDATE lg.subscriptions SET state = 'trialing' WHERE org_id = $1`, [state.orgId]);
  const r = await ingest(state.sourceKey, { entry_id: 'dis_1', email: 'd@example.com' }, state.secret);
  assert.equal(r.status, 410);
  const en = await call('POST', `/api/v1/sources/${state.sourceId}/enable`, OWNER, {}, { 'idempotency-key': idem() });
  assert.equal(en.status, 200);
  assert.equal(en.body.data.status, 'testing');
});

test('Outbox rows carry IDs only and are published by the worker', async () => {
  await publishOutbox(worker, 1000);
  const left = await h.admin.query('SELECT count(*)::int n FROM lg.outbox_events WHERE published_at IS NULL');
  assert.equal(left.rows[0].n, 0);
  const payloads = await h.admin.query('SELECT payload::text p FROM lg.outbox_events');
  for (const r of payloads.rows) {
    // Fixture contact values (names, emails, phone digits) must never appear; IDs may contain any digits.
    assert.ok(!/dana|morales|greg|example\.com|5125550142|555-0142|5125550101/i.test(r.p), `contact data in outbox payload: ${r.p}`);
  }
});
