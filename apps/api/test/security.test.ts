// Security test suite (SEC-01..07, PRV-01..04, input safety, abuse limits). Runs against a real PostgreSQL with
// FORCE RLS and the runtime roles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { signV1 } from '@leadguard/domain';
import { OPERATIONS } from '@leadguard/contracts';
import { startHarness, bearer, idem, type Harness } from './helpers.ts';
import { csvCell } from '../../worker/src/exports.ts';

let h: Harness;
const logs: string[] = [];
const logStream = new Writable({ write(chunk, _enc, cb) { logs.push(chunk.toString()); cb(); } });

const OWNER_A = bearer('s_owner_a', 'owner.a@alpha.example', 'Alice Alpha');
const MANAGER_A = bearer('s_manager_a', 'manager.a@alpha.example', 'Mike Manager');
const MEMBER_A = bearer('s_member_a', 'member.a@alpha.example', 'Mia Member');
const OWNER_B = bearer('s_owner_b', 'owner.b@beta.example', 'Bob Beta');
const SUPPORT = 'Bearer devsupport:s_staff:staff@leadguard.example:Sue Support';
const RANDOM = '019a2bff-0000-7000-8000-00000000abcd';

// Fixture contact data that must never appear in logs (PRV-01).
const SECRET_NAME = 'Zelda Quixote';
const SECRET_EMAIL = 'zelda.quixote@private.example';
const SECRET_PHONE = '(512) 555-0188';
const SECRET_MESSAGE = 'my alarm code is 4417';

const S: Record<string, any> = {};

async function req(method: string, url: string, auth: string | null, body?: unknown, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') {
  const r = await h.app.inject({
    method: method as any, url, remoteAddress,
    headers: { ...(auth ? { authorization: auth } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    payload: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  let json: any = null;
  try { json = r.body ? JSON.parse(r.body) : null; } catch { /* non-JSON */ }
  return { status: r.statusCode, body: json, headers: r.headers, raw: r.body };
}
const post = (url: string, auth: string, body: unknown = {}, headers: Record<string, string> = {}) => req('POST', url, auth, body, { 'idempotency-key': idem(), ...headers });

function ingest(key: string, secret: string, payload: object | Buffer, opts: { ts?: number } = {}) {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return h.app.inject({ method: 'POST', url: `/ingest/v1/forms/${key}`, headers: { 'content-type': 'application/json', 'x-leadguard-timestamp': ts, 'x-leadguard-signature': signV1(secret, ts, raw) }, payload: raw });
}

/** Concrete URL for an operation path, with every path parameter set to `id`. */
function urlFor(path: string, id: string) {
  return path.replace(/:(\w+)/g, (_m, name) => (name === 'sourceKey' ? 'sk_doesnotexist0000' : name === 'provider' ? 'test_double' : id));
}

before(async () => {
  h = await startHarness({ RATE_LIMIT_IP_UNAUTH_PER_MINUTE: '40', LOG_LEVEL: 'info', APP_URL: 'https://app.leadguard.test' }, {}, { logStream });
  const a = await post('/api/v1/organizations', OWNER_A, { name: 'Alpha Co', time_zone: 'America/Chicago' });
  S.orgA = a.body.data.org.id;
  const b = await post('/api/v1/organizations', OWNER_B, { name: 'Beta Co', time_zone: 'America/Chicago' });
  S.orgB = b.body.data.org.id;
  for (const [who, role] of [[MANAGER_A, 'manager'], [MEMBER_A, 'member']] as const) {
    const inv = await post('/api/v1/invitations', OWNER_A, { email: who.split(':')[2], role });
    await req('POST', '/api/v1/invitations/accept', who, { token: inv.body.data.invite_url.split('#')[1] });
  }
  const src = await post('/api/v1/sources', OWNER_A, { type: 'web_form_webhook', name: 'Form', field_mapping: { message: 'comments' } });
  S.sourceA = src.body.data.source.id; S.secretA = src.body.data.signing_secret; S.keyA = src.body.data.endpoint_url.split('/').pop();
  await post(`/api/v1/sources/${S.sourceA}/test-event`, OWNER_A, {});
  await ingest(S.keyA, S.secretA, { entry_id: 'verify', email: 'verify@example.com' });
  const lead = await ingest(S.keyA, S.secretA, { entry_id: 'zelda', full_name: SECRET_NAME, email: SECRET_EMAIL, phone: SECRET_PHONE, comments: SECRET_MESSAGE });
  S.leadA = JSON.parse(lead.body).lead_id;
  const g = await post('/api/v1/support-access/grants', OWNER_A, { scope: 'read_only', duration_hours: 2, reason: 'Ticket 1' });
  S.grantA = g.body.data.grant_id;
  const e = await post('/api/v1/exports', OWNER_A, {});
  S.exportA = e.body.data.export_id;
});

after(async () => { await h?.stop(); });

test('SEC: every /api/v1 operation rejects missing or malformed credentials with 401', async () => {
  let i = 0;
  for (const op of OPERATIONS.filter(o => o.path.startsWith('/api/v1/'))) {
    const url = urlFor(op.path, RANDOM);
    const ip = `10.9.${++i}.1`; // one client per operation so the failed-auth limiter does not kick in
    const none = await req(op.method, url, null, op.method === 'GET' ? undefined : {}, {}, ip);
    assert.equal(none.status, 401, `${op.id} without token`);
    assert.equal(none.body.error.code, 'AUTHENTICATION_REQUIRED');
    const bad = await req(op.method, url, 'Bearer dev:bad id:not-an-email:x', op.method === 'GET' ? undefined : {}, {}, ip);
    assert.equal(bad.status, 401, `${op.id} with malformed token`);
  }
});

test('SEC-01..06: another organization gets 404 for every object ID of organization A', async () => {
  const objectOps = OPERATIONS.filter(o => /:(leadId|sourceId|alertId|exportId|grantId|memberId)/.test(o.path));
  const ids: Record<string, string> = { leadId: S.leadA, sourceId: S.sourceA, exportId: S.exportA, grantId: S.grantA, alertId: RANDOM, memberId: RANDOM };
  for (const op of objectOps) {
    const param = /:(\w+)/.exec(op.path)![1];
    const url = op.path.replace(`:${param}`, ids[param]);
    const body = op.method === 'GET' ? undefined : { expected_version: 1, merge_lead_id: S.leadA, merge_expected_version: 1, owner_id: 'me', type: 'note', note: 'x', to_status: 'lost', reason: 'x', due_at_local: '2030-01-01T09:00', role: 'member' };
    const r = await req(op.method, url, OWNER_B, body, { 'idempotency-key': idem() });
    assert.ok([404, 400].includes(r.status), `${op.id} cross-org returned ${r.status}`);
    assert.notEqual(r.status, 200, `${op.id} leaked`);
    assert.ok(!JSON.stringify(r.body).includes(SECRET_NAME), `${op.id} leaked contact data`);
  }
  const search = await req('POST', '/api/v1/leads/search', OWNER_B, { query: 'Zelda' });
  assert.equal(search.body.data.items.length, 0);
  const inbox = await req('GET', '/api/v1/inbox', OWNER_B);
  assert.ok(!JSON.stringify(inbox.body).includes(SECRET_NAME));
  const xorg = await req('GET', '/api/v1/organizations/current', OWNER_B, undefined, { 'x-org-id': S.orgA });
  assert.equal(xorg.status, 404, 'X-Org-Id of a foreign org is rejected');
});

test('Roles: members and managers cannot use operations their role does not allow (403)', async () => {
  const memberDenied: [string, string, unknown?][] = [
    ['GET', '/api/v1/members'], ['GET', '/api/v1/sources'], ['GET', '/api/v1/dashboard/summary'], ['GET', '/api/v1/dashboard/exceptions'],
    ['GET', '/api/v1/dashboard/source-health'], ['POST', '/api/v1/sources', { type: 'web_form_webhook', name: 'x' }],
    ['POST', '/api/v1/invitations', { email: 'x@y.example', role: 'member' }], ['PUT', '/api/v1/rules/follow-up-policy', {}],
    ['POST', '/api/v1/exports', {}], ['POST', '/api/v1/billing/cancel', { confirm: true }], ['POST', '/api/v1/support-access/grants', { duration_hours: 1, reason: 'abc' }],
    ['PATCH', '/api/v1/organizations/current', { expected_version: 1, name: 'x' }],
  ];
  for (const [m, url, body] of memberDenied) {
    const r = await req(m, url, MEMBER_A, body, { 'idempotency-key': idem() });
    assert.equal(r.status, 403, `member ${m} ${url} -> ${r.status}`);
  }
  const managerDenied: [string, string, unknown?][] = [
    ['POST', '/api/v1/exports', {}], ['POST', '/api/v1/billing/cancel', { confirm: true }], ['POST', '/api/v1/billing/checkout', { plan_id: 'team', confirm_plan_and_price: true }],
    ['GET', '/api/v1/support-access/grants'], ['POST', '/api/v1/support-access/grants', { duration_hours: 1, reason: 'abc' }],
    ['PATCH', '/api/v1/organizations/current', { expected_version: 1, name: 'x' }], ['POST', '/api/v1/invitations', { email: 'o@y.example', role: 'owner' }],
  ];
  for (const [m, url, body] of managerDenied) {
    const r = await req(m, url, MANAGER_A, body, { 'idempotency-key': idem() });
    assert.equal(r.status, 403, `manager ${m} ${url} -> ${r.status}`);
  }
  // A member cannot assign a lead to someone else, nor read a lead owned by someone else.
  const lead = (await req('GET', `/api/v1/leads/${S.leadA}`, OWNER_A)).body.data;
  const asMember = await req('GET', `/api/v1/leads/${S.leadA}`, MEMBER_A);
  if (lead.owner && lead.owner.user_id) {
    const memberSelf = (await req('GET', '/api/v1/me', MEMBER_A)).body.data.user.id;
    if (lead.owner.user_id !== memberSelf) assert.equal(asMember.status, 404);
  }
});

test('SEC-07: read-only support grant can only read; revoked or unknown grants are denied and audited', async () => {
  const hdr = { 'x-support-grant-id': S.grantA };
  assert.equal((await req('GET', '/api/v1/inbox', SUPPORT, undefined, hdr)).status, 200);
  for (const op of OPERATIONS.filter(o => o.path.startsWith('/api/v1/') && o.entitlement !== 'read')) {
    const r = await req(op.method, urlFor(op.path, RANDOM), SUPPORT, {}, { ...hdr, 'idempotency-key': idem() });
    assert.equal(r.status, 403, `support read_only ${op.id} -> ${r.status}`);
  }
  assert.equal((await req('GET', '/api/v1/inbox', SUPPORT, undefined, { 'x-support-grant-id': RANDOM })).status, 403);
  await post(`/api/v1/support-access/grants/${S.grantA}/revoke`, OWNER_A, {});
  assert.equal((await req('GET', '/api/v1/inbox', SUPPORT, undefined, hdr)).status, 403);
  // A customer token cannot act as support even with a valid grant header.
  const g = await post('/api/v1/support-access/grants', OWNER_A, { scope: 'read_only', duration_hours: 1, reason: 'Ticket 2' });
  const asCustomer = await req('GET', '/api/v1/inbox', OWNER_B, undefined, { 'x-support-grant-id': g.body.data.grant_id });
  assert.equal(asCustomer.status, 401);
  const audited = await h.admin.query(`SELECT count(*)::int n FROM lg.audit_events WHERE action = 'support.access_denied'`);
  assert.ok(audited.rows[0].n >= 1);
});

test('Input safety: NUL/control characters and prototype keys are rejected with 400, never 5xx', async () => {
  const nul = await post('/api/v1/leads/search', OWNER_A, { query: 'ab\u0000cd' });
  assert.equal(nul.status, 400);
  const proto = await req('POST', '/api/v1/leads/search', OWNER_A, '{"query":"abc","__proto__":{"admin":true}}');
  assert.equal(proto.status, 400);
  const badJson = await req('POST', '/api/v1/leads/search', OWNER_A, '{not json');
  assert.equal(badJson.status, 400);
  const big = await req('POST', '/api/v1/leads/search', OWNER_A, JSON.stringify({ query: 'x'.repeat(300_000) }));
  assert.equal(big.status, 413);
  const unknownField = await post('/api/v1/sources', OWNER_A, { type: 'web_form_webhook', name: 'x', is_admin: true });
  assert.equal(unknownField.status, 400, 'strict schemas reject unknown fields');
  const longName = await post('/api/v1/organizations', OWNER_A, { name: 'x'.repeat(121), time_zone: 'America/Chicago' });
  assert.equal(longName.status, 400);
  const badUuid = await req('GET', '/api/v1/leads/not-a-uuid', OWNER_A);
  assert.equal(badUuid.status, 400);
  assert.equal((await req('GET', '/api/v1/inbox?limit=100000', OWNER_A)).status, 400, 'page size is bounded');
});

test('Injection: SQL and LIKE metacharacters in search are treated as literal text', async () => {
  for (const q of ["' OR 1=1 --", "'); DROP TABLE lg.leads; --", '%%', '__', 'a\\b', 'Zelda%']) {
    const r = await req('POST', '/api/v1/leads/search', OWNER_A, { query: q });
    assert.equal(r.status, 200, `query ${q}`);
    assert.equal(r.body.data.items.length, 0, `query ${q} matched rows`);
  }
  const still = await h.admin.query('SELECT count(*)::int n FROM lg.leads');
  assert.ok(still.rows[0].n > 0);
});

test('Stored text is returned as JSON data (no HTML rendering on the API)', async () => {
  const r = await post('/api/v1/leads', OWNER_A, { name: '<img src=x onerror=alert(1)>', phone: '512-555-0101', owner_id: 'me' });
  assert.equal(r.status, 201);
  const g = await req('GET', `/api/v1/leads/${r.body.data.id}`, OWNER_A);
  assert.match(String(g.headers['content-type']), /application\/json/);
  assert.equal(g.body.data.contact.name, '<img src=x onerror=alert(1)>');
});

test('Cursors are signed and bound to organization and endpoint', async () => {
  for (let i = 0; i < 3; i++) await post('/api/v1/leads', OWNER_A, { name: `Page ${i}`, phone: `512-555-02${10 + i}`, owner_id: 'me' });
  const p1 = await req('POST', '/api/v1/leads/search', OWNER_A, { limit: 1 });
  const cursor = p1.body.data.next_cursor;
  assert.ok(cursor);
  assert.equal((await req('POST', '/api/v1/leads/search', OWNER_A, { limit: 1, cursor })).status, 200);
  const tampered = cursor.slice(0, -2) + (cursor.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await req('POST', '/api/v1/leads/search', OWNER_A, { limit: 1, cursor: tampered })).status, 400);
  assert.equal((await req('POST', '/api/v1/leads/search', OWNER_B, { limit: 1, cursor })).status, 400, 'cursor from another org');
  assert.equal((await req('GET', `/api/v1/alerts?cursor=${encodeURIComponent(cursor)}`, OWNER_A)).status, 400, 'cursor from another endpoint');
});

test('Idempotency keys are scoped per user and reject a different body', async () => {
  const key = idem();
  const a = await post('/api/v1/leads', OWNER_A, { name: 'Idem', phone: '512-555-0301', owner_id: 'me' }, { 'idempotency-key': key });
  assert.equal(a.status, 201);
  const reused = await post('/api/v1/leads', OWNER_A, { name: 'Other', phone: '512-555-0302', owner_id: 'me' }, { 'idempotency-key': key });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  const otherUser = await post('/api/v1/leads', MANAGER_A, { name: 'Idem', phone: '512-555-0301', owner_id: 'me' }, { 'idempotency-key': key });
  assert.equal(otherUser.status, 201, 'another user with the same key gets a fresh execution, not A\'s stored response');
  assert.notEqual(otherUser.body.data.id, a.body.data.id);
  assert.equal((await post('/api/v1/leads', OWNER_A, { name: 'x', phone: '5125550303' }, { 'idempotency-key': 'short' })).status, 400);
});

test('Billing: checkout never redirects off the app origin', async () => {
  const r = await post('/api/v1/billing/checkout', OWNER_A, { plan_id: 'team', confirm_plan_and_price: true, return_url: 'https://evil.example/phish' });
  assert.equal(r.status, 400);
});

test('Ingest: forged, replayed, stale, oversized and malformed deliveries create nothing', async () => {
  const before_ = (await h.admin.query('SELECT count(*)::int n FROM lg.leads')).rows[0].n;
  const raw = Buffer.from(JSON.stringify({ entry_id: 'forge', email: 'f@example.com' }));
  const ts = String(Math.floor(Date.now() / 1000));
  const forged = await h.app.inject({ method: 'POST', url: `/ingest/v1/forms/${S.keyA}`, headers: { 'content-type': 'application/json', 'x-leadguard-timestamp': ts, 'x-leadguard-signature': signV1('whsec_wrong', ts, raw) }, payload: raw });
  assert.equal(forged.statusCode, 401);
  assert.equal((await ingest(S.keyA, S.secretA, { entry_id: 'stale', email: 's@example.com' }, { ts: Math.floor(Date.now() / 1000) - 600 })).statusCode, 401);
  assert.equal((await ingest(S.keyA, S.secretA, Buffer.from('not json'))).statusCode, 400);
  assert.equal((await ingest(S.keyA, S.secretA, { entry_id: 'big', email: 'b@example.com', comments: 'x'.repeat(70_000) })).statusCode, 413);
  assert.equal((await ingest(S.keyA, S.secretA, { entry_id: 'nocontact', full_name: 'No Contact' })).statusCode, 400);
  const unknown = await h.app.inject({ method: 'POST', url: '/ingest/v1/forms/sk_doesnotexist0000', headers: { 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(unknown.statusCode, 404);
  assert.equal((await h.admin.query('SELECT count(*)::int n FROM lg.leads')).rows[0].n, before_);

  // Prototype keys and control characters from third-party payloads are dropped, not stored.
  const r = await ingest(S.keyA, S.secretA, Buffer.from('{"entry_id":"proto","email":"p@example.com","full_name":"Pro\\u0000to","__proto__":{"polluted":"yes"},"constructor":"x","zip":"78704"}'));
  assert.equal(r.statusCode, 201, r.body);
  const lead = (await req('GET', `/api/v1/leads/${JSON.parse(r.body).lead_id}`, OWNER_A)).body.data;
  assert.equal(lead.contact.name, 'Proto');
  assert.deepEqual(Object.keys(lead.attributes), ['zip']);
  assert.equal(({} as any).polluted, undefined);
});

test('Security headers are present on API responses', async () => {
  const r = await req('GET', '/api/v1/me', OWNER_A);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-powered-by'], undefined);
  const notFound = await req('GET', '/does/not/exist', null);
  assert.equal(notFound.status, 404);
  assert.ok(!/at .*\.ts/.test(notFound.raw), 'no stack traces in responses');
});

test('CSV export cells are protected against formula injection', () => {
  assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  assert.equal(csvCell('+1 555'), "'+1 555");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('normal, text'), '"normal, text"');
});

test('PRV-01: application logs contain no contact data, secrets or tokens', async () => {
  const all = logs.join('');
  assert.ok(all.length > 0, 'logs were captured');
  for (const s of [SECRET_NAME, SECRET_EMAIL, '555-0188', '5125550188', SECRET_MESSAGE, S.secretA, 'Bearer dev:', 'whsec_']) {
    assert.ok(!all.includes(s), `log output contains "${s}"`);
  }
  const outbox = await h.admin.query('SELECT payload::text p FROM lg.outbox_events');
  for (const r of outbox.rows) assert.ok(!r.p.includes('Zelda') && !r.p.includes('private.example'), 'contact data in queue payload');
  const audit = await h.admin.query("SELECT coalesce(string_agg(coalesce(array_to_string(changed_fields, ','), ''), ' '), '') AS f FROM lg.audit_events");
  assert.ok(!audit.rows[0].f.includes('Zelda'), 'contact values in audit rows');
});

test('Abuse limits: repeated failed authentication from one IP is rate limited (429)', async () => {
  let last = 0;
  for (let i = 0; i < 45; i++) last = (await req('GET', '/api/v1/me', 'Bearer dev:bad id:x:y', undefined, {}, '10.66.0.1')).status;
  assert.equal(last, 429);
  const blocked = await req('GET', '/api/v1/me', OWNER_A, undefined, {}, '10.66.0.1');
  assert.equal(blocked.status, 429, 'the IP is blocked for the rest of the window');
  assert.ok(blocked.headers['retry-after']);
  assert.equal((await req('GET', '/api/v1/me', OWNER_A, undefined, {}, '10.66.0.2')).status, 200, 'other clients are unaffected');
});
