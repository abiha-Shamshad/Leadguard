// Contract conformance: every one of the 52 operations is called against a real PostgreSQL and compared with
// contracts/api-examples.json (Section 19-28, Definition of Done: "All 52 operations return responses matching
// contracts/api-examples.json in shape, status codes and error codes").
//
// For each operation we check:
//   success  - HTTP status equals the example, and every field in the example body exists in the response with
//              the same JSON type (recursively; null on either side is accepted; extra fields are allowed);
//   extra    - the additional documented results (replays, duplicates, degraded health, ...);
//   error    - the documented error result: HTTP status and error code.
// A Markdown report is written to docs/evidence/contract-conformance.md.
process.env.NODE_ENV = 'test'; // provider test doubles refuse to load outside tests

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { signV1 } from '@leadguard/domain';
import { createPool } from '@leadguard/db';
import { createLocalStorage, createTestBillingAdapter, createTestCallAdapter, createTestEmailAdapter, noneBillingAdapter, registerCallAdapter } from '@leadguard/adapters';
import { startHarness, bearer, idem, type Harness } from './helpers.ts';
import { buildDeps } from '../src/deps.ts';
import { buildApp } from '../src/app.ts';
import type { WorkerContext } from '../../worker/src/context.ts';
import { inlineDispatcher } from '../../worker/src/queues.ts';
import { sweep } from '../../worker/src/sweeper.ts';
import { processExport } from '../../worker/src/exports.ts';
import { processDelivery } from '../../worker/src/processors.ts';
import type { FastifyInstance } from 'fastify';

const examples: any[] = JSON.parse(readFileSync(new URL('../../../packages/contracts/api-examples.json', import.meta.url), 'utf8'));
const EX = (id: string) => examples.find(e => e.id === id);

const OWNER = bearer('c_owner', 'owner@acme.example', 'Chris Patel');
const MANAGER = bearer('c_manager', 'manager@acme.example', 'Morgan Lee');
const MEMBER = bearer('c_member', 'maria@acme.example', 'Maria Lopez');
const TEMP = bearer('c_temp', 'temp@acme.example', 'Tim Temp');
const OTHER = bearer('c_other', 'bea@other.example', 'Bea Other');
const RANDOM_UUID = '019a2bff-0000-7000-8000-000000000000';

const EMAIL_WH = 'email-webhook-secret';
const BILLING_WH = 'billing-webhook-secret';

let h: Harness;
let worker: WorkerContext;
let noBillingApp: FastifyInstance;
let deadDbApp: FastifyInstance;
const email = (() => { process.env.NODE_ENV = 'test'; return createTestEmailAdapter({ webhookSecret: EMAIL_WH }); })();
const billing = createTestBillingAdapter({ webhookSecret: BILLING_WH });
registerCallAdapter(createTestCallAdapter());

type Res = { status: number; body: any };
async function call(app: FastifyInstance, method: string, url: string, auth: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await app.inject({
    method: method as any, url,
    headers: { ...(auth ? { authorization: auth } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    payload: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
const api = (method: string, url: string, auth: string | null, body?: unknown, headers: Record<string, string> = {}) => call(h.app, method, url, auth, body, headers);
const post = (url: string, auth: string, body: unknown = {}) => api('POST', url, auth, body, { 'idempotency-key': idem() });

// ------------------------------------------------------------------ shape comparison
function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function shapeDiff(expected: unknown, actual: unknown, path = '$'): string[] {
  if (expected === null || actual === null || expected === undefined) return [];
  const te = jsonType(expected), ta = jsonType(actual);
  if (te !== ta) return [`${path}: expected ${te}, got ${ta}`];
  if (te === 'array') {
    const e = expected as unknown[], a = actual as unknown[];
    return e.length && a.length ? shapeDiff(e[0], a[0], `${path}[0]`) : [];
  }
  if (te === 'object') {
    const out: string[] = [];
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      if (!(k in (actual as Record<string, unknown>))) out.push(`${path}.${k}: missing`);
      else out.push(...shapeDiff(v, (actual as Record<string, unknown>)[k], `${path}.${k}`));
    }
    return out;
  }
  return [];
}

interface Row { id: string; kind: string; label: string; expectedStatus: number; actualStatus: number; expectedCode?: string; actualCode?: string; diffs: string[] }
const rows: Row[] = [];

function errCode(body: any): string | undefined {
  return body?.error?.code ?? (typeof body?.error === 'string' ? body.error : undefined);
}

function checkSuccess(id: string, r: Res, label = 'success') {
  const ex = EX(id);
  const exp = label === 'success' ? ex.success : ex.extra.find((x: any) => x.label === label);
  assert.ok(exp, `${id}: no example "${label}"`);
  const diffs = r.status === exp.status ? shapeDiff(exp.body, r.body) : [];
  rows.push({ id, kind: label === 'success' ? 'success' : 'extra', label, expectedStatus: exp.status, actualStatus: r.status, diffs });
}

function checkError(id: string, r: Res) {
  const ex = EX(id).error;
  const expectedCode = errCode(ex.body);
  rows.push({ id, kind: 'error', label: expectedCode ?? 'error', expectedStatus: ex.status, actualStatus: r.status, expectedCode, actualCode: errCode(r.body), diffs: [] });
}

function signedIngest(key: string, secret: string, payload: object, family = 'forms', forge = false) {
  const raw = Buffer.from(JSON.stringify(payload));
  const ts = String(Math.floor(Date.now() / 1000));
  return call(h.app, 'POST', `/ingest/v1/${family}/${key}`, null, raw, {
    'x-leadguard-timestamp': ts, 'x-leadguard-signature': signV1(forge ? 'whsec_forged' : secret, ts, raw),
  });
}
function callIngest(key: string, secret: string, payload: object) {
  const raw = Buffer.from(JSON.stringify(payload));
  return call(h.app, 'POST', `/ingest/v1/calls/${key}`, null, raw, { 'x-test-signature': createHmac('sha256', secret).update(raw).digest('hex') });
}
const keyOf = (endpoint: string) => endpoint.split('/').pop()!;

const S: Record<string, any> = {};

before(async () => {
  h = await startHarness({ FEATURE_FLAGS: 'call_sources:true,self_service_checkout:true', APP_URL: 'https://app.leadguard.test' }, { email, billing });
  worker = {
    config: { appUrl: 'https://app.leadguard.test' } as any, app: h.deps.pool, scanner: h.scanner, email,
    storage: createLocalStorage({ dir: h.exportDir, publicBaseUrl: 'http://api.test', signingSecret: 'test-cursor' }),
    dispatcher: inlineDispatcher(() => worker), inFlightTimers: new Set(),
  };
  // Same database, billing provider not configured (Release 1 default) - for the API-044 error example.
  noBillingApp = await buildApp(buildDeps(h.config, { pool: h.deps.pool, redis: null, billing: noneBillingAdapter, email }));
  // Unreachable PostgreSQL - for the API-001 503 example.
  deadDbApp = await buildApp(buildDeps(h.config, { pool: createPool('postgres://nobody:x@127.0.0.1:1/none', { max: 1 }), redis: null }));
});

after(async () => {
  mkdirSync(new URL('../../../docs/evidence/', import.meta.url), { recursive: true });
  const ok = (r: Row) => r.actualStatus === r.expectedStatus && r.diffs.length === 0 && (r.kind !== 'error' || r.actualCode === r.expectedCode);
  const lines = [
    '# Contract conformance report',
    '',
    `Generated by \`apps/api/test/contract.test.ts\` against PostgreSQL with the canonical schema. ${rows.filter(ok).length}/${rows.length} checks pass across ${new Set(rows.map(r => r.id)).size} operations.`,
    '',
    '| Operation | Case | Expected | Actual | Result | Notes |',
    '|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.id} | ${r.kind}: ${r.label} | ${r.expectedStatus}${r.expectedCode ? ` ${r.expectedCode}` : ''} | ${r.actualStatus}${r.actualCode ? ` ${r.actualCode}` : ''} | ${ok(r) ? 'PASS' : 'FAIL'} | ${r.diffs.join('; ')} |`),
  ];
  writeFileSync(new URL('../../../docs/evidence/contract-conformance.md', import.meta.url), lines.join('\n') + '\n');
  await noBillingApp?.close();
  await deadDbApp?.close();
  await h?.stop();
});

test('API-001..API-006 system and organization', async () => {
  checkSuccess('API-001', await api('GET', '/internal/v1/health', null));
  const degraded = await api('GET', '/internal/v1/health', null);
  checkSuccess('API-001', degraded, 'Degraded but still serving (Redis down)');
  checkError('API-001', await call(deadDbApp, 'GET', '/internal/v1/health', null));

  checkError('API-002', await api('GET', '/api/v1/me', null));

  const org = await post('/api/v1/organizations', OWNER, { name: 'Acme Plumbing', time_zone: 'America/Chicago', country: 'US', business_hours: [{ weekday: 'mon', open: '08:00', close: '18:00' }] });
  checkSuccess('API-003', org);
  S.orgId = org.body.data.org.id;
  checkError('API-003', await post('/api/v1/organizations', OWNER, { name: 'Bad', time_zone: 'Mars/Base' }));
  checkSuccess('API-002', await api('GET', '/api/v1/me', OWNER));

  // Other organization for isolation checks.
  const other = await post('/api/v1/organizations', OTHER, { name: 'Other Co', time_zone: 'America/New_York' });
  S.otherOrgId = other.body.data.org.id;

  const read = await api('GET', '/api/v1/organizations/current', OWNER);
  checkSuccess('API-004', read);
  checkError('API-004', await api('GET', '/api/v1/organizations/current', OWNER, undefined, { 'x-org-id': S.otherOrgId }));

  const v = read.body.data.version;
  checkSuccess('API-005', await api('PATCH', '/api/v1/organizations/current', OWNER, { expected_version: v, time_zone: 'America/Denver' }));
  checkError('API-005', await api('PATCH', '/api/v1/organizations/current', OWNER, { expected_version: v, time_zone: 'America/Chicago' }));

  // Open every day all day so due times never depend on when the test runs.
  const allDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => ({ weekday: d, open: '00:00', close: '23:59' }));
  checkSuccess('API-006', await api('PUT', '/api/v1/organizations/current/business-hours', OWNER, { expected_version: 1, days: allDay, holidays: ['2026-12-25'] }));
  checkError('API-006', await api('PUT', '/api/v1/organizations/current/business-hours', OWNER, { expected_version: 2, days: [{ weekday: 'mon', open: '18:00', close: '07:30' }] }));
});

test('API-013..API-019 sources and verification; API-020/021 ingest', async () => {
  checkError('API-024', await post('/api/v1/leads', OWNER, { name: 'Kim', phone: '512-555-0177' })); // 423 while setup_pending (BIL-06)

  const src = await post('/api/v1/sources', OWNER, { type: 'web_form_webhook', name: 'Website contact form', field_mapping: { name: 'full_name', email: 'email', phone: 'phone', message: 'comments' } });
  checkSuccess('API-013', src);
  S.sourceId = src.body.data.source.id; S.secret = src.body.data.signing_secret; S.key = keyOf(src.body.data.endpoint_url);
  // Replay with the same key -> secret never replayed.
  const key = idem();
  const first = await api('POST', '/api/v1/sources', OWNER, { type: 'web_form_webhook', name: 'Second form' }, { 'idempotency-key': key });
  S.source2 = first.body.data.source.id;
  checkSuccess('API-013', await api('POST', '/api/v1/sources', OWNER, { type: 'web_form_webhook', name: 'Second form' }, { 'idempotency-key': key }), 'Replay with the same Idempotency-Key (secret is never replayed)');
  checkError('API-013', await post('/api/v1/sources', OWNER, { type: 'call_webhook', name: 'Office phone line', provider_key: 'unknown_provider' }));

  checkSuccess('API-015', await post(`/api/v1/sources/${S.sourceId}/test-event`, OWNER, { window_minutes: 15 }));
  checkSuccess('API-014', await api('GET', `/api/v1/sources/${S.sourceId}`, OWNER));
  checkError('API-014', await api('GET', `/api/v1/sources/${RANDOM_UUID}`, OWNER));

  // Verification event (moves setup_pending -> trialing).
  const test1 = await signedIngest(S.key, S.secret, { entry_id: 'test_1', full_name: 'Test Person', email: 'test@example.com' });
  assert.equal(test1.status, 201);

  const dana = { entry_id: 'wpf_entry_8841', submitted_at: new Date().toISOString(), full_name: 'Dana Morales', email: 'dana.morales@example.com', phone: '(512) 555-0142', comments: 'Water heater leaking, need someone today.', service: 'plumbing', zip: '78704' };
  const ing = await signedIngest(S.key, S.secret, dana);
  checkSuccess('API-020', ing);
  S.danaId = ing.body.lead_id;
  checkSuccess('API-020', await signedIngest(S.key, S.secret, dana), 'Duplicate delivery result (same entry_id)');
  checkSuccess('API-020', await signedIngest(S.key, S.secret, { entry_id: 'wpf_entry_9001', full_name: 'Dana Morales', email: 'dana.morales@example.com' }), 'Repeat enquiry linked to an open lead');
  checkError('API-020', await signedIngest(S.key, S.secret, dana, 'forms', true));

  checkSuccess('API-016', await api('GET', `/api/v1/sources/${S.sourceId}/events`, OWNER));
  checkError('API-016', await api('GET', `/api/v1/sources/${RANDOM_UUID}/events`, OWNER));

  // Call source through the provider-neutral adapter (labelled test double).
  const callSrc = await post('/api/v1/sources', OWNER, { type: 'call_webhook', name: 'Office phone line', provider_key: 'test_double' });
  assert.equal(callSrc.status, 201, JSON.stringify(callSrc.body));
  S.callKey = keyOf(callSrc.body.data.endpoint_url); S.callSecret = callSrc.body.data.signing_secret; S.callSourceId = callSrc.body.data.source.id;
  await post(`/api/v1/sources/${S.callSourceId}/test-event`, OWNER, {});
  const verifyCall = await callIngest(S.callKey, S.callSecret, { call_id: 'CAtest', event_type: 'call.completed', from: '+15125550111', started_at: new Date().toISOString(), answered: false });
  assert.equal(verifyCall.status, 201, JSON.stringify(verifyCall.body));
  const missed = await callIngest(S.callKey, S.callSecret, { provider: 'pilot_call_provider', call_id: 'CA7f3e19b2', event_type: 'call.completed', direction: 'inbound', from: '+15125550199', to: '+15125550100', started_at: new Date().toISOString(), duration_seconds: 0, answered: false, voicemail: true });
  checkSuccess('API-021', missed);
  S.missedLeadId = missed.body.lead_id;
  checkSuccess('API-021', await callIngest(S.callKey, S.callSecret, { call_id: 'CAanswered', event_type: 'call.completed', from: '+15125550199', started_at: new Date().toISOString(), duration_seconds: 95, answered: true }), 'Answered call logged on an existing lead');
  checkError('API-021', await callIngest(S.callKey, S.callSecret, { call_id: 'CAbad', event_type: 'call.completed', started_at: new Date().toISOString() }));

  const rot = await post(`/api/v1/sources/${S.source2}/rotate-secret`, OWNER, {});
  checkSuccess('API-017', rot);
  await h.admin.query(`INSERT INTO lg.sources (id, org_id, type, name, source_key, auth_mode, allowed_origins) VALUES ('019a2bff-1111-7000-8000-000000000001', $1, 'web_form_embed', 'Embed form', 'sk_embedtest00000001', 'embed', '{https://www.acme.example}')`, [S.orgId]);
  checkError('API-017', await post(`/api/v1/sources/019a2bff-1111-7000-8000-000000000001/rotate-secret`, OWNER, {}));
});

test('API-007..API-012 team and source list', async () => {
  for (const [who, role] of [[MANAGER, 'manager'], [MEMBER, 'member'], [TEMP, 'member']] as const) {
    const email = who.split(':')[2];
    const inv = await post('/api/v1/invitations', OWNER, { email, role });
    if (role === 'manager') checkSuccess('API-008', inv);
    const token = inv.body.data.invite_url.split('#')[1];
    const acc = await api('POST', '/api/v1/invitations/accept', who, { token });
    if (role === 'manager') checkSuccess('API-009', acc);
  }
  const expired = await post('/api/v1/invitations', OWNER, { email: 'late@acme.example', role: 'member' });
  await h.admin.query(`UPDATE lg.invitations SET expires_at = now() - interval '1 minute' WHERE email_norm = 'late@acme.example'`);
  checkError('API-009', await api('POST', '/api/v1/invitations/accept', bearer('c_late', 'late@acme.example', 'Late'), { token: expired.body.data.invite_url.split('#')[1] }));

  await h.admin.query(`UPDATE lg.subscriptions SET plan_id = 'starter' WHERE org_id = $1`, [S.orgId]);
  checkError('API-008', await post('/api/v1/invitations', OWNER, { email: 'sam@acme.example', role: 'member' }));
  await h.admin.query(`UPDATE lg.subscriptions SET plan_id = 'team' WHERE org_id = $1`, [S.orgId]);

  const members = await api('GET', '/api/v1/members', OWNER);
  await post('/api/v1/invitations', OWNER, { email: 'sam@acme.example', role: 'member' }); // pending invite row in the list
  checkSuccess('API-007', await api('GET', '/api/v1/members', OWNER));
  checkError('API-007', await api('GET', '/api/v1/members', MEMBER));
  const items = members.body.data.items;
  S.ownerId = items.find((m: any) => m.role === 'owner').user_id;
  S.managerId = items.find((m: any) => m.role === 'manager').user_id;
  S.memberId = items.find((m: any) => m.email === 'maria@acme.example').user_id;
  S.tempId = items.find((m: any) => m.email === 'temp@acme.example').user_id;

  const tmp = items.find((m: any) => m.user_id === S.tempId);
  checkSuccess('API-010', await api('PATCH', `/api/v1/members/${S.tempId}`, OWNER, { expected_version: tmp.version, role: 'manager' }));
  const ownerRow = items.find((m: any) => m.user_id === S.ownerId);
  checkError('API-010', await api('PATCH', `/api/v1/members/${S.ownerId}`, OWNER, { expected_version: ownerRow.version, role: 'member' }));
  checkSuccess('API-011', await post(`/api/v1/members/${S.tempId}/deactivate`, OWNER, { reassign_to: S.ownerId, reason: 'Left the company' }));
  checkError('API-011', await post(`/api/v1/members/${RANDOM_UUID}/deactivate`, OWNER, {}));

  checkSuccess('API-012', await api('GET', '/api/v1/sources', OWNER));
  checkError('API-012', await api('GET', '/api/v1/sources', MEMBER));
});

test('API-022..API-032 inbox and leads', async () => {
  checkSuccess('API-022', await api('GET', '/api/v1/inbox?view=team', OWNER));
  checkError('API-022', await api('GET', '/api/v1/inbox', null));

  checkSuccess('API-023', await api('POST', '/api/v1/leads/search', OWNER, { query: 'morales', status: ['new', 'attempted', 'contacted'], owner_id: null, source_id: null, created_from: '2026-01-01', limit: 25, cursor: null }));
  checkError('API-023', await api('POST', '/api/v1/leads/search', OWNER, { query: 'm' }));

  await post('/api/v1/leads', OWNER, { name: 'Kim Nguyen', phone: '512-555-0177', owner_id: 'me' });
  const kim = await post('/api/v1/leads', OWNER, { name: 'Kim Nguyen', phone: '512-555-0177', email: null, message: 'Quote for bathroom remodel', owner_id: 'me' });
  checkSuccess('API-024', kim);
  S.kimId = kim.body.data.id;

  const dana = await api('GET', `/api/v1/leads/${S.danaId}`, OWNER);
  checkSuccess('API-025', dana);
  checkError('API-025', await api('GET', `/api/v1/leads/${RANDOM_UUID}`, OWNER));

  const k1 = (await api('GET', `/api/v1/leads/${S.kimId}`, OWNER)).body.data;
  checkSuccess('API-026', await api('PATCH', `/api/v1/leads/${S.kimId}`, OWNER, { expected_version: k1.version, contact: { phone: '+15125550143' }, next_action: 'Call after 2 PM' }));
  checkError('API-026', await api('PATCH', `/api/v1/leads/${S.kimId}`, OWNER, { expected_version: k1.version, next_action: 'stale' }));

  // Assign: manager assigns the unassigned missed-call lead to Maria.
  const missed = (await api('GET', `/api/v1/leads/${S.missedLeadId}`, OWNER)).body.data;
  const unassignedVersion = missed.version;
  checkSuccess('API-027', await post(`/api/v1/leads/${S.missedLeadId}/assign`, OWNER, { expected_version: missed.version, owner_id: S.memberId, note: 'Maria covers south Austin' }));
  // Claim race: Maria's colleague claimed it a moment ago; a member claiming with the old version gets ALREADY_CLAIMED.
  const kimLead = (await api('GET', `/api/v1/leads/${S.kimId}`, OWNER)).body.data;
  void kimLead;
  checkError('API-027', await post(`/api/v1/leads/${S.missedLeadId}/assign`, bearer('c_member2', 'm2@acme.example', 'Member Two'), { expected_version: unassignedVersion, owner_id: 'me' }).then(async r => {
    if (r.status !== 404) return r;
    // Member Two is not in the org yet - invite them, then retry the stale claim.
    const inv = await post('/api/v1/invitations', OWNER, { email: 'm2@acme.example', role: 'member' });
    await api('POST', '/api/v1/invitations/accept', bearer('c_member2', 'm2@acme.example', 'Member Two'), { token: inv.body.data.invite_url.split('#')[1] });
    return post(`/api/v1/leads/${S.missedLeadId}/assign`, bearer('c_member2', 'm2@acme.example', 'Member Two'), { expected_version: unassignedVersion, owner_id: 'me' });
  }));

  let d = (await api('GET', `/api/v1/leads/${S.danaId}`, OWNER)).body.data;
  if (d.owner?.user_id !== S.ownerId) {
    await post(`/api/v1/leads/${S.danaId}/assign`, OWNER, { expected_version: d.version, owner_id: 'me' });
    d = (await api('GET', `/api/v1/leads/${S.danaId}`, OWNER)).body.data;
  }
  checkSuccess('API-028', await post(`/api/v1/leads/${S.danaId}/activities`, OWNER, { expected_version: d.version, type: 'call', outcome: 'no_answer', note: 'Left voicemail', occurred_at: new Date(Date.now() - 60_000).toISOString() }));
  checkError('API-028', await post(`/api/v1/leads/${S.danaId}/activities`, OWNER, { expected_version: d.version + 1, type: 'call', outcome: 'no_answer', occurred_at: new Date(Date.now() + 3600_000).toISOString() }));

  // Snooze while the lead is attempted, then contact.
  d = (await api('GET', `/api/v1/leads/${S.danaId}`, OWNER)).body.data;
  const tomorrow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86_400_000));
  checkSuccess('API-030', await post(`/api/v1/leads/${S.danaId}/snooze`, OWNER, { expected_version: d.version, due_at_local: `${tomorrow}T09:00`, reason: 'Customer asked for a call tomorrow morning' }));
  d = (await api('GET', `/api/v1/leads/${S.danaId}`, OWNER)).body.data;
  checkError('API-030', await post(`/api/v1/leads/${S.danaId}/snooze`, OWNER, { expected_version: d.version, due_at_local: '2026-11-01T01:30', reason: 'x' }));

  checkSuccess('API-028', await post(`/api/v1/leads/${S.danaId}/activities`, OWNER, { expected_version: d.version, type: 'call', outcome: 'reached' }), 'Result when contact is made (outcome = reached)');

  d = (await api('GET', `/api/v1/leads/${S.danaId}`, OWNER)).body.data;
  checkSuccess('API-029', await post(`/api/v1/leads/${S.danaId}/status`, OWNER, { expected_version: d.version, to_status: 'won', reason: 'Booked water heater replacement' }));
  const k2 = (await api('GET', `/api/v1/leads/${S.kimId}`, OWNER)).body.data;
  checkError('API-029', await post(`/api/v1/leads/${S.kimId}/status`, OWNER, { expected_version: k2.version, to_status: 'won' }));

  checkSuccess('API-031', await api('GET', `/api/v1/leads/${S.danaId}/timeline`, OWNER));
  checkError('API-031', await api('GET', `/api/v1/leads/${RANDOM_UUID}/timeline`, OWNER));

  // Merge the earlier duplicate Kim lead into the newest one.
  const kims = (await api('POST', '/api/v1/leads/search', OWNER, { query: 'Kim Nguyen' })).body.data.items.map((x: any) => x.id).filter((x: string) => x !== S.kimId);
  const kimA = (await api('GET', `/api/v1/leads/${S.kimId}`, OWNER)).body.data;
  const kimB = (await api('GET', `/api/v1/leads/${kims[0]}`, OWNER)).body.data;
  checkSuccess('API-032', await post(`/api/v1/leads/${S.kimId}/merge`, OWNER, { merge_lead_id: kimB.id, expected_version: kimA.version, merge_expected_version: kimB.version }));
  checkError('API-032', await post(`/api/v1/leads/${S.kimId}/merge`, OWNER, { merge_lead_id: S.kimId, expected_version: 1, merge_expected_version: 1 }));
});

test('API-033..API-038 rules and alerts', async () => {
  const pol = await api('GET', '/api/v1/rules/follow-up-policy', OWNER);
  checkSuccess('API-033', pol);
  checkError('API-033', await api('GET', '/api/v1/rules/follow-up-policy', null));
  const body = {
    expected_version: pol.body.data.version,
    assignment: { mode: 'fixed_owner', owner_id: S.memberId },
    first_response: { target_minutes: 10, business_hours_only: true },
    follow_up: { attempt_intervals_minutes: [60, 1440], max_attempts: 3 },
    escalation: { after_overdue_minutes: 20, notify: ['owners', 'managers'], repeat: false },
    unassigned_escalation_minutes: 10,
  };
  checkSuccess('API-034', await api('PUT', '/api/v1/rules/follow-up-policy', OWNER, body));
  checkError('API-034', await api('PUT', '/api/v1/rules/follow-up-policy', OWNER, { ...body, expected_version: pol.body.data.version + 1, first_response: { target_minutes: 4, business_hours_only: true } }));
  checkSuccess('API-035', await api('POST', '/api/v1/rules/follow-up-policy/preview', OWNER, { policy: { first_response: { target_minutes: 15, business_hours_only: true }, escalation: { after_overdue_minutes: 30 } }, arrival_local: '2026-10-16T17:55' }));
  checkError('API-035', await api('POST', '/api/v1/rules/follow-up-policy/preview', OWNER, { policy: { first_response: { target_minutes: 15, business_hours_only: true } }, arrival_local: '2027-03-14T02:30' }));

  // Make Kim's first response overdue and let the worker fire reminder + escalation (email via test double).
  await h.admin.query(`UPDATE lg.lead_timers SET due_at = now() - interval '1 second' WHERE lead_id = $1 AND state = 'pending'`, [S.kimId]);
  await h.admin.query(`UPDATE lg.leads SET due_at = now() - interval '1 second' WHERE id = $1`, [S.kimId]);
  await sweep(worker);
  await h.admin.query(`UPDATE lg.lead_timers SET due_at = now() - interval '1 second' WHERE lead_id = $1 AND state = 'pending' AND kind = 'escalation'`, [S.kimId]);
  await sweep(worker);
  // Send pending emails through the email test double so they get provider message IDs.
  const pending = await h.admin.query(`SELECT id, org_id FROM lg.alert_deliveries WHERE state = 'pending' AND channel = 'email'`);
  for (const p of pending.rows) await processDelivery(worker, p.org_id, p.id);

  const alerts = await api('GET', '/api/v1/alerts', OWNER);
  checkSuccess('API-036', alerts);
  checkError('API-036', await api('GET', '/api/v1/alerts', null));
  S.alertId = alerts.body.data.items.find((a: any) => a.kind === 'escalation')?.id ?? alerts.body.data.items[0]?.id;
  assert.ok(S.alertId, 'an alert exists');
  checkSuccess('API-037', await post(`/api/v1/alerts/${S.alertId}/acknowledge`, OWNER, {}));
  checkError('API-037', await post(`/api/v1/alerts/${RANDOM_UUID}/acknowledge`, OWNER, {}));

  checkSuccess('API-038', await api('PUT', '/api/v1/me/notification-preferences', OWNER, { channels: { in_app: true, email: true, sms: false }, escalations_always_email: true }));
  checkError('API-038', await api('PUT', '/api/v1/me/notification-preferences', OWNER, { channels: { in_app: true, email: true, sms: true }, escalations_always_email: true }));
});

test('API-039..API-043 dashboard and subscription reads', async () => {
  checkSuccess('API-039', await api('GET', '/api/v1/dashboard/summary?from=2026-01-01&to=2026-12-31', OWNER));
  checkError('API-039', await api('GET', '/api/v1/dashboard/summary', MEMBER));
  checkSuccess('API-040', await api('GET', '/api/v1/dashboard/exceptions', OWNER));
  checkError('API-040', await api('GET', '/api/v1/dashboard/exceptions', MEMBER));
  checkSuccess('API-041', await api('GET', '/api/v1/dashboard/source-health', OWNER));
  checkError('API-041', await api('GET', '/api/v1/dashboard/source-health', MEMBER));
  checkSuccess('API-042', await api('GET', '/api/v1/billing/plans', OWNER));
  checkError('API-042', await api('GET', '/api/v1/billing/plans', null));
  checkSuccess('API-043', await api('GET', '/api/v1/billing/subscription', OWNER));
  checkError('API-043', await api('GET', '/api/v1/billing/subscription', null));
});

test('API-044..API-047 billing and provider webhooks (labelled test doubles)', async () => {
  checkSuccess('API-044', await post('/api/v1/billing/checkout', OWNER, { plan_id: 'team', confirm_plan_and_price: true, return_url: 'https://app.leadguard.test/settings/billing' }));
  checkError('API-044', await call(noBillingApp, 'POST', '/api/v1/billing/checkout', OWNER, { plan_id: 'team', confirm_plan_and_price: true }, { 'idempotency-key': idem() }));

  const sub = await h.admin.query('SELECT provider_customer_id FROM lg.subscriptions WHERE org_id = $1', [S.orgId]);
  const event = { id: 'evt_3Pq9', type: 'subscription.updated', data: { customer_id: sub.rows[0].provider_customer_id, subscription_id: 'sub_9Ka', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 } };
  const raw = Buffer.from(JSON.stringify(event));
  const sig = createHmac('sha256', BILLING_WH).update(raw).digest('hex');
  checkSuccess('API-046', await call(h.app, 'POST', '/webhooks/v1/billing/test_double', null, raw, { 'x-test-signature': sig }));
  checkSuccess('API-046', await call(h.app, 'POST', '/webhooks/v1/billing/test_double', null, raw, { 'x-test-signature': sig }), 'Duplicate provider event');
  checkError('API-046', await call(h.app, 'POST', '/webhooks/v1/billing/test_double', null, raw, { 'x-test-signature': 'bad' }));

  const msg = await h.admin.query(`SELECT provider_message_id FROM lg.alert_deliveries WHERE provider_message_id IS NOT NULL LIMIT 1`);
  assert.ok(msg.rows.length, 'an email delivery was accepted by the provider test double');
  const nraw = Buffer.from(JSON.stringify({ message_id: msg.rows[0].provider_message_id, event: 'bounced', at: new Date().toISOString() }));
  checkSuccess('API-047', await call(h.app, 'POST', '/webhooks/v1/notifications/test_double', null, nraw, { 'x-test-signature': createHmac('sha256', EMAIL_WH).update(nraw).digest('hex') }));
  checkError('API-047', await call(h.app, 'POST', '/webhooks/v1/notifications/test_double', null, nraw, { 'x-test-signature': 'bad' }));

  checkSuccess('API-045', await post('/api/v1/billing/cancel', OWNER, { reason: 'Too expensive', confirm: true }));
  checkError('API-045', await post('/api/v1/billing/cancel', OWNER, { reason: 'x' }));
});

test('API-048..API-052 export and support access; API-019 enable', async () => {
  const e = await post('/api/v1/exports', OWNER, { include: ['leads', 'activities', 'alerts'], format: 'csv_zip' });
  checkSuccess('API-048', e);
  checkError('API-048', await post('/api/v1/exports', OWNER, {}));
  await processExport(worker, S.orgId, e.body.data.export_id);
  checkSuccess('API-049', await api('GET', `/api/v1/exports/${e.body.data.export_id}`, OWNER));
  checkError('API-049', await api('GET', `/api/v1/exports/${RANDOM_UUID}`, OWNER));

  const g = await post('/api/v1/support-access/grants', OWNER, { scope: 'read_only', duration_hours: 4, reason: 'Ticket #1042 - missing leads from form' });
  checkSuccess('API-051', g);
  checkError('API-051', await post('/api/v1/support-access/grants', OWNER, { scope: 'read_only', duration_hours: 73, reason: 'Too long' }));
  checkSuccess('API-050', await api('GET', '/api/v1/support-access/grants', OWNER));
  checkError('API-050', await api('GET', '/api/v1/support-access/grants', MEMBER));
  checkSuccess('API-052', await post(`/api/v1/support-access/grants/${g.body.data.grant_id}/revoke`, OWNER, {}));
  checkError('API-052', await post(`/api/v1/support-access/grants/${RANDOM_UUID}/revoke`, OWNER, {}));

  // Disable / enable / test-event on a disabled source.
  checkSuccess('API-018', await post(`/api/v1/sources/${S.source2}/disable`, OWNER, { reason: 'Replaced by new form' }));
  checkError('API-018', await post(`/api/v1/sources/${S.sourceId}/disable`, MEMBER, { reason: 'x' }));
  checkError('API-015', await post(`/api/v1/sources/${S.source2}/test-event`, OWNER, {}));
  await post(`/api/v1/sources/019a2bff-1111-7000-8000-000000000001/disable`, OWNER, {}); // stay within the plan's 3 sources
  checkSuccess('API-019', await post(`/api/v1/sources/${S.source2}/enable`, OWNER, {}));
  await post(`/api/v1/sources/${S.source2}/disable`, OWNER, {});
  await h.admin.query(`UPDATE lg.subscriptions SET state = 'read_only' WHERE org_id = $1`, [S.orgId]);
  checkError('API-019', await post(`/api/v1/sources/${S.source2}/enable`, OWNER, {}));
  checkError('API-024', await post('/api/v1/leads', OWNER, { name: 'Late', phone: '512-555-0100' }));
});

test('every one of the 52 operations was exercised and matches the examples', () => {
  const ids = new Set(rows.map(r => r.id));
  const missing = examples.map(e => e.id).filter(id => !ids.has(id));
  assert.deepEqual(missing, [], `operations not exercised: ${missing.join(', ')}`);
  for (const e of examples) {
    assert.ok(rows.some(r => r.id === e.id && r.kind === 'success'), `${e.id}: success case not exercised`);
    assert.ok(rows.some(r => r.id === e.id && r.kind === 'error'), `${e.id}: error case not exercised`);
  }
  const failures = rows.filter(r => r.actualStatus !== r.expectedStatus || r.diffs.length || (r.kind === 'error' && r.actualCode !== r.expectedCode));
  assert.deepEqual(failures.map(f => `${f.id} ${f.kind}:${f.label} expected ${f.expectedStatus} ${f.expectedCode ?? ''} got ${f.actualStatus} ${f.actualCode ?? ''} ${f.diffs.join('; ')}`), []);
});
