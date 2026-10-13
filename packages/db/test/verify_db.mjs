// LeadGuard database verification suite. Runs against a disposable PostgreSQL with 001_core_schema.sql applied.
// Usage: PGHOST=/tmp PGPORT=55432 PGDATABASE=lgtest node verify_db.mjs
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';

const base = { host: process.env.PGHOST, port: Number(process.env.PGPORT), database: process.env.PGDATABASE };
const admin = new pg.Pool({ ...base, user: 'postgres', max: 2 });
const app = new pg.Pool({ ...base, user: 'lg_app', max: 1 });      // max 1 forces connection reuse
const app2 = new pg.Pool({ ...base, user: 'lg_app', max: 2 });
const scanner = new pg.Pool({ ...base, user: 'lg_scanner', max: 2 });

const results = [];
async function check(id, name, fn) {
  try { await fn(); results.push([id, name, 'PASS', '']); }
  catch (e) { results.push([id, name, 'FAIL', e.message]); }
}
function assert(c, m) { if (!c) throw new Error(m); }

async function inOrg(pool, orgId, userId, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [orgId, userId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

// ---------- fixtures created through the real bootstrap path
const uA = randomUUID(), uB = randomUUID(), orgA = randomUUID(), orgB = randomUUID();
async function setup() {
  const c = await app.connect();
  try {
    await c.query('SELECT lg.upsert_user($1,$2,$3,$4)', [uA, 'user_clerk_A', 'chris@acme.example', 'Chris']);
    await c.query('SELECT lg.upsert_user($1,$2,$3,$4)', [uB, 'user_clerk_B', 'bea@other.example', 'Bea']);
    await c.query('SELECT lg.bootstrap_organization($1,$2,$3,$4,$5)', [orgA, 'Acme Plumbing', 'America/Chicago', 'US', uA]);
    await c.query('SELECT lg.bootstrap_organization($1,$2,$3,$4,$5)', [orgB, 'Other Co', 'America/New_York', 'US', uB]);
  } finally { c.release(); }
}
const srcA = randomUUID(), srcB = randomUUID();
async function sources() {
  await inOrg(app, orgA, uA, c => c.query("INSERT INTO lg.sources (id, org_id, type, name, source_key, auth_mode) VALUES ($1,$2,'web_form_webhook','Form','sk_a_1','hmac_v1')", [srcA, orgA]));
  await inOrg(app, orgB, uB, c => c.query("INSERT INTO lg.sources (id, org_id, type, name, source_key, auth_mode) VALUES ($1,$2,'web_form_webhook','Form','sk_b_1','hmac_v1')", [srcB, orgB]));
}
async function newLead(org, user, src, extra = {}) {
  const id = randomUUID();
  await inOrg(app, org, user, c => c.query(
    "INSERT INTO lg.leads (id, org_id, source_id, name, phone_e164, owner_id, status, merged_into) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, org, src, 'Dana', '+15125550142', extra.owner ?? user, extra.status ?? 'new', extra.merged_into ?? null]));
  return id;
}

await setup(); await sources();

await check('DB-01', 'SET LOCAL with a bind parameter is rejected by PostgreSQL (spec v1.0 Section 15 bug)', async () => {
  const c = await app.connect();
  try { await c.query('BEGIN'); await c.query('SET LOCAL app.org_id = $1', [orgA]); throw new Error('unexpectedly succeeded'); }
  catch (e) { assert(/syntax error/.test(e.message), 'expected syntax error, got: ' + e.message); }
  finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
});

await check('DB-02', 'Missing org context returns zero rows for lg_app', async () => {
  const r = await app.query('SELECT count(*)::int n FROM lg.sources');
  assert(r.rows[0].n === 0, 'saw ' + r.rows[0].n + ' rows without context');
});

await check('DB-03', 'Org A context cannot read org B rows', async () => {
  const n = await inOrg(app, orgA, uA, async c => (await c.query('SELECT count(*)::int n FROM lg.sources WHERE id = $1', [srcB])).rows[0].n);
  assert(n === 0, 'cross-org read');
});

await check('DB-04', 'Org A context cannot insert a row for org B (WITH CHECK)', async () => {
  try { await inOrg(app, orgA, uA, c => c.query("INSERT INTO lg.sources (id, org_id, type, name, source_key, auth_mode) VALUES ($1,$2,'web_form_webhook','x','sk_x','hmac_v1')", [randomUUID(), orgB])); throw new Error('insert allowed'); }
  catch (e) { assert(/row-level security/.test(e.message), e.message); }
});

await check('DB-05', 'Context does not leak to the next transaction on a reused pooled connection', async () => {
  await inOrg(app, orgA, uA, c => c.query('SELECT 1'));
  const r = await app.query("SELECT current_setting('app.org_id', true) v, (SELECT count(*)::int FROM lg.leads) n");
  assert(!r.rows[0].v && r.rows[0].n === 0, 'context leaked: ' + JSON.stringify(r.rows[0]));
});

await check('DB-06', 'Ingest bootstrap: resolve_source works with no org context and returns only routing columns', async () => {
  const r = await app.query('SELECT * FROM lg.resolve_source($1)', ['sk_a_1']);
  assert(r.rows.length === 1 && r.rows[0].org_id === orgA && Object.keys(r.rows[0]).length === 5, JSON.stringify(r.rows));
});

await check('DB-07', 'users table: a member cannot read users of another organization', async () => {
  const n = await inOrg(app, orgA, uA, async c => (await c.query('SELECT count(*)::int n FROM lg.users WHERE id = $1', [uB])).rows[0].n);
  assert(n === 0, 'saw foreign user');
});

await check('DB-08', 'Two concurrent deliveries with the same dedupe key create one source_event and two delivery_attempts', async () => {
  const leadId = await newLead(orgA, uA, srcA);
  const deliver = () => inOrg(app2, orgA, uA, async c => {
    const ins = await c.query(
      "INSERT INTO lg.source_events (id, org_id, source_id, dedupe_key, kind, occurred_at, outcome, lead_id) VALUES ($1,$2,$3,'form:8841','form_submission',now(),'lead_created',$4) ON CONFLICT (source_id, dedupe_key) DO NOTHING RETURNING id",
      [randomUUID(), orgA, srcA, leadId]);
    const result = ins.rowCount ? 'accepted' : 'duplicate';
    await c.query("INSERT INTO lg.delivery_attempts (id, org_id, source_id, result, body_sha256) VALUES ($1,$2,$3,$4,$5)",
      [randomUUID(), orgA, srcA, result, createHash('sha256').update('body').digest()]);
    return result;
  });
  const out = await Promise.all([deliver(), deliver()]);
  const counts = await inOrg(app, orgA, uA, async c => (await c.query(
    "SELECT (SELECT count(*)::int FROM lg.source_events WHERE dedupe_key='form:8841') e, (SELECT count(*)::int FROM lg.delivery_attempts) a")).rows[0]);
  assert(counts.e === 1 && counts.a === 2 && out.sort().join() === 'accepted,duplicate', JSON.stringify({ out, counts }));
});

let timerA, timerB, leadA;
await check('DB-09', 'Scanner sees pending timers of all orgs, but not leads and not fired timers', async () => {
  leadA = await newLead(orgA, uA, srcA);
  const leadB = await newLead(orgB, uB, srcB);
  timerA = randomUUID(); timerB = randomUUID();
  await inOrg(app, orgA, uA, c => c.query("INSERT INTO lg.lead_timers (id, org_id, lead_id, kind, cycle, due_at, policy_version) VALUES ($1,$2,$3,'first_response_due',1,now() - interval '1 minute',1)", [timerA, orgA, leadA]));
  await inOrg(app, orgB, uB, c => c.query("INSERT INTO lg.lead_timers (id, org_id, lead_id, kind, cycle, due_at, policy_version) VALUES ($1,$2,$3,'first_response_due',1,now() - interval '1 minute',1)", [timerB, orgB, leadB]));
  const r = await scanner.query("SELECT id, org_id FROM lg.lead_timers WHERE state = 'pending' AND due_at <= now()");
  assert(r.rows.length === 2, 'scanner saw ' + r.rows.length);
  try { await scanner.query('SELECT id FROM lg.leads LIMIT 1'); throw new Error('scanner read leads'); }
  catch (e) { assert(/permission denied/.test(e.message), e.message); }
  try { await scanner.query('SELECT lead_id FROM lg.lead_timers LIMIT 1'); throw new Error('scanner read lead_id column'); }
  catch (e) { assert(/permission denied/.test(e.message), e.message); }
});

await check('DB-10', 'Two concurrent scanners claim disjoint timers with FOR UPDATE SKIP LOCKED', async () => {
  const claim = async () => {
    const c = await scanner.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query("SELECT id FROM lg.lead_timers WHERE state='pending' AND due_at <= now() ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED");
      await new Promise(res => setTimeout(res, 200));
      if (r.rows[0]) await c.query("UPDATE lg.lead_timers SET state='claimed', claimed_until = now() + interval '2 minutes' WHERE id=$1", [r.rows[0].id]);
      await c.query('COMMIT');
      return r.rows[0]?.id ?? null;
    } finally { c.release(); }
  };
  const [a, b] = await Promise.all([claim(), claim()]);
  assert(a && b && a !== b, 'claims overlapped: ' + a + ' ' + b);
});

await check('DB-11', 'One alert per timer occurrence; a new cycle allows a new alert', async () => {
  const ins = (timer) => inOrg(app, orgA, uA, c => c.query("INSERT INTO lg.alerts (id, org_id, lead_id, timer_id, kind, policy_version) VALUES ($1,$2,$3,$4,'reminder',1) ON CONFLICT (timer_id) DO NOTHING RETURNING id", [randomUUID(), orgA, leadA, timer]));
  const first = await ins(timerA), replay = await ins(timerA);
  await inOrg(app, orgA, uA, c => c.query("UPDATE lg.lead_timers SET state='fired' WHERE id=$1", [timerA]));
  const timer2 = randomUUID();
  await inOrg(app, orgA, uA, c => c.query("INSERT INTO lg.lead_timers (id, org_id, lead_id, kind, cycle, due_at, policy_version) VALUES ($1,$2,$3,'first_response_due',2,now(),1)", [timer2, orgA, leadA]));
  const second = await ins(timer2);
  assert(first.rowCount === 1 && replay.rowCount === 0 && second.rowCount === 1, [first.rowCount, replay.rowCount, second.rowCount].join());
});

await check('DB-12', 'Only one pending timer per lead and kind', async () => {
  try { await inOrg(app, orgA, uA, c => c.query("INSERT INTO lg.lead_timers (id, org_id, lead_id, kind, cycle, due_at, policy_version) VALUES ($1,$2,$3,'first_response_due',3,now(),1)", [randomUUID(), orgA, leadA])); throw new Error('second pending timer allowed'); }
  catch (e) { assert(/ux_timer_one_pending/.test(e.message), e.message); }
});

await check('DB-13', "Status 'reopened' is rejected; 'merged' requires merged_into", async () => {
  try { await newLead(orgA, uA, srcA, { status: 'reopened' }); throw new Error('reopened accepted'); } catch (e) { assert(/check constraint/.test(e.message), e.message); }
  try { await newLead(orgA, uA, srcA, { status: 'merged' }); throw new Error('merged without target accepted'); } catch (e) { assert(/check constraint/.test(e.message), e.message); }
  await newLead(orgA, uA, srcA, { status: 'merged', merged_into: leadA });
});

await check('DB-14', 'Lead owner must be a member of the same org (composite FK)', async () => {
  try { await newLead(orgA, uA, srcA, { owner: uB }); throw new Error('foreign owner accepted'); }
  catch (e) { assert(/foreign key/.test(e.message), e.message); }
});

await check('DB-15', 'lg_app cannot update audit_events', async () => {
  await inOrg(app, orgA, uA, c => c.query("INSERT INTO lg.audit_events (org_id, actor_type, action) VALUES ($1,'user','test')", [orgA]));
  try { await inOrg(app, orgA, uA, c => c.query("UPDATE lg.audit_events SET action='x'")); throw new Error('update allowed'); }
  catch (e) { assert(/permission denied/.test(e.message), e.message); }
});

await check('DB-16', 'Support grant longer than 72 hours is rejected', async () => {
  try { await inOrg(app, orgA, uA, c => c.query("INSERT INTO lg.support_access_grants (id, org_id, scope, reason, granted_by, expires_at) VALUES ($1,$2,'read_only','t',$3, now() + interval '73 hours')", [randomUUID(), orgA, uA])); throw new Error('accepted'); }
  catch (e) { assert(/check constraint/.test(e.message), e.message); }
});

await check('DB-17', 'Runtime roles do not have BYPASSRLS', async () => {
  const r = await admin.query("SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('lg_app','lg_scanner','lg_owner')");
  assert(r.rows.every(x => !x.rolbypassrls), JSON.stringify(r.rows));
});

await check('DB-18', 'Tables are owned by lg_owner and FORCE RLS is enabled on every tenant table', async () => {
  const r = await admin.query("SELECT c.relname, pg_get_userbyid(c.relowner) owner, c.relforcerowsecurity f FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lg' AND c.relkind='r'");
  const bad = r.rows.filter(x => x.owner !== 'lg_owner' || (!x.f && !['billing_events'].includes(x.relname)));
  assert(bad.length === 0, JSON.stringify(bad));
});

await check('DB-19', 'Organization limit: a user cannot own more than 3 organizations', async () => {
  for (let i = 0; i < 2; i++) await app.query('SELECT lg.bootstrap_organization($1,$2,$3,$4,$5)', [randomUUID(), 'X' + i, 'America/Chicago', 'US', uA]);
  try { await app.query('SELECT lg.bootstrap_organization($1,$2,$3,$4,$5)', [randomUUID(), 'X9', 'America/Chicago', 'US', uA]); throw new Error('4th org allowed'); }
  catch (e) { assert(/ORG_LIMIT_REACHED/.test(e.message), e.message); }
});

for (const p of [admin, app, app2, scanner]) await p.end();
const w = results.map(r => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3].replace(/\|/g, '/')} |`).join('\n');
console.log('| Check | Behavior | Status | Detail |\n|---|---|---|---|\n' + w);
process.exit(results.some(r => r[2] === 'FAIL') ? 1 : 0);
