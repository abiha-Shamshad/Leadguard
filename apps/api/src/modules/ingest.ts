// API-020 / API-021 Ingest pipeline (Section 10). Public, source-authenticated, minimal envelopes.
// Raw bytes are captured before JSON parsing and verified against (SIG-03). The response is sent only after
// commit, so a provider retry after a timeout hits the unique (source_id, dedupe_key) and gets the original result.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getOperation } from '@leadguard/contracts';
import {
  hashDedupeKey, normalizeEmail, normalizePhone, providerDedupeKey, uuidv7, verifySecretHeader, verifyV1,
} from '@leadguard/domain';
import {
  applyActivity, audit, effectiveState, emit, getSubscription, loadOrgSettings, withOrg, withoutOrg, type Db, createLead,
} from '@leadguard/db';
import { getCallAdapter } from '@leadguard/adapters';
import type { Deps } from '../deps.ts';
import { registeredOperations } from '../lib/route.ts';
import { decryptSecret, sha256 } from '../lib/crypto.ts';
import { isForbiddenKey, stripControlChars } from '../lib/input-safety.ts';
import { openWindow, recordSteps, stepDetail, type OpenWindow, type StepName } from '../lib/verification.ts';

const MAX_BODY = 64 * 1024;
const MAX_ATTRIBUTES = 20;
const MAX_ATTRIBUTE_LEN = 500;
const MATCH_DAYS = 30;
const HONEYPOT_FIELD = '_lg_hp';
const CHALLENGE_FIELD = '_lg_challenge';

interface IngestResponse { status: number; body: Record<string, unknown>; corsOrigin?: string }

interface SourceDetail {
  id: string; org_id: string; type: string; name: string; status: string; auth_mode: string;
  secret_enc: Buffer | null; prev_secret_enc: Buffer | null; prev_secret_valid_until: Date | null;
  allowed_origins: string[]; field_mapping: Record<string, string>; provider_key: string | null;
}

const FALLBACK_FIELDS: Record<string, string[]> = {
  name: ['name', 'full_name', 'fullName', 'your-name', 'first_name'],
  email: ['email', 'email_address', 'your-email'],
  phone: ['phone', 'phone_number', 'tel', 'telephone', 'your-phone'],
  message: ['message', 'comments', 'comment', 'your-message', 'details'],
  entry_id: ['entry_id', 'submission_id', 'id'],
  submitted_at: ['submitted_at', 'created_at', 'timestamp'],
};

function ok(requestId: string, status: number, fields: Record<string, unknown>): IngestResponse {
  return { status, body: { accepted: true, ...fields, request_id: requestId } };
}
function fail(requestId: string, status: number, code: string, message: string): IngestResponse {
  return { status, body: { accepted: false, error: { code, message, retryable: status === 429 || status >= 500 }, request_id: requestId } };
}

/** Map the provider payload into canonical fields using the source's field_mapping (Section 9.3). */
export function mapFormPayload(body: Record<string, unknown>, mapping: Record<string, string>) {
  const used = new Set<string>([HONEYPOT_FIELD, CHALLENGE_FIELD]);
  const pick = (field: string): string | null => {
    const keys = mapping[field] ? [mapping[field]] : FALLBACK_FIELDS[field];
    for (const k of keys) {
      const v = body[k];
      if (v !== undefined && v !== null && v !== '') {
        used.add(k);
        return typeof v === 'string' ? stripControlChars(v) : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : null;
      }
    }
    return null;
  };
  const canonical = {
    name: pick('name'), email: pick('email'), phone: pick('phone'), message: pick('message'),
    entry_id: pick('entry_id'), submitted_at: pick('submitted_at'),
  };
  const attributes: Record<string, string> = Object.create(null);
  let dropped = 0;
  for (const [k, v] of Object.entries(body)) {
    if (used.has(k)) continue;
    const str = typeof v === 'string' ? stripControlChars(v) : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : null;
    // Prototype-pollution keys and control characters in keys are dropped (counted in the attempt record).
    if (str === null || isForbiddenKey(k) || /[\u0000-\u001F\u007F]/.test(k) || str.length > MAX_ATTRIBUTE_LEN || k.length > 60 || Object.keys(attributes).length >= MAX_ATTRIBUTES) { dropped++; continue; }
    attributes[k] = str;
  }
  return { canonical, attributes: { ...attributes }, dropped };
}

export function registerIngest(app: FastifyInstance, deps: Deps): void {
  // Raw body for every content type on the ingest routes; parsed only after authentication.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1_048_576 }, (_req, body, done) => done(null, body));

  for (const [opId, family] of [['API-020', 'forms'], ['API-021', 'calls']] as const) {
    const op = getOperation(opId);
    registeredOperations().add(op.id);
    app.post(op.path, { config: { operationId: op.id, entitlement: op.entitlement } }, async (req, reply) => {
      const r = await ingest(deps, req, family);
      if (r.corsOrigin) reply.header('Access-Control-Allow-Origin', r.corsOrigin).header('Vary', 'Origin');
      return reply.code(r.status).send(r.body);
    });
  }

  // CORS preflight for embed sources (exact origin allowlist; embed stays feature-flagged off until INT-005).
  app.options('/ingest/v1/forms/:sourceKey', async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    const key = (req.params as { sourceKey: string }).sourceKey;
    if (deps.config.flags.embed_sources && origin && /^sk_[A-Za-z0-9]{8,40}$/.test(key)) {
      const src = await withoutOrg(deps.pool, db => db.maybe<{ org_id: string; source_id: string; auth_mode: string }>('SELECT source_id, org_id, auth_mode FROM lg.resolve_source($1)', [key]));
      if (src?.auth_mode === 'embed') {
        const allowed = await withOrg(deps.pool, src.org_id, null, db => db.maybe<{ allowed_origins: string[] }>('SELECT allowed_origins FROM lg.sources WHERE id = $1', [src.source_id]));
        if (allowed?.allowed_origins.includes(origin)) {
          reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
            .header('Access-Control-Allow-Methods', 'POST').header('Access-Control-Allow-Headers', 'Content-Type, X-LeadGuard-Challenge').header('Access-Control-Max-Age', '600');
        }
      }
    }
    return reply.code(204).send();
  });
}

async function ingest(deps: Deps, req: FastifyRequest, family: 'forms' | 'calls'): Promise<IngestResponse> {
  const rid = req.requestId;
  const key = (req.params as { sourceKey: string }).sourceKey;
  if (!/^sk_[A-Za-z0-9]{8,40}$/.test(key)) return fail(rid, 404, 'NOT_FOUND', 'Unknown source.');

  const rl = await deps.limiter.hit(`ingest:${key}`, 120, 60);
  if (!rl.allowed) return fail(rid, 429, 'RATE_LIMITED', 'Too many events. Retry later.');

  // Pre-context bootstrap lookup: returns only routing columns (DB-06).
  const resolved = await withoutOrg(deps.pool, db => db.maybe<{ source_id: string; org_id: string; type: string; status: string; auth_mode: string }>(
    'SELECT source_id, org_id, type, status, auth_mode FROM lg.resolve_source($1)', [key]));
  const expectedFamily = resolved?.type === 'call_webhook' ? 'calls' : 'forms';
  if (!resolved || expectedFamily !== family) return fail(rid, 404, 'NOT_FOUND', 'Unknown source.');

  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const bodySha = sha256(raw);
  try {
    const r = await withOrg(deps.pool, resolved.org_id, null, db => processEvent(deps, db, req, family, resolved.source_id, raw, bodySha));
    return r.corsOrigin ? { ...r.response, corsOrigin: r.corsOrigin } : r.response;
  } catch (e) {
    req.log.error({ request_id: rid, source_id: resolved.source_id, err: { message: (e as Error).message, code: (e as any).code } }, 'ingest failed');
    await withOrg(deps.pool, resolved.org_id, null, db => db.q(
      `INSERT INTO lg.delivery_attempts (id, org_id, source_id, result, reason_code, body_sha256, auth_mode) VALUES ($1,$2,$3,'failed','INTERNAL_ERROR',$4,$5)`,
      [uuidv7(), resolved.org_id, resolved.source_id, bodySha, resolved.auth_mode])).catch(() => {});
    return fail(rid, 503, 'SERVICE_UNAVAILABLE', 'Temporary failure. Retry later.');
  }
}

async function processEvent(deps: Deps, db: Db, req: FastifyRequest, family: 'forms' | 'calls', sourceId: string, raw: Buffer, bodySha: Buffer):
  Promise<{ response: IngestResponse; corsOrigin?: string }> {
  const rid = req.requestId;
  // Lock the source row: serializes verification/health updates and concurrent duplicate deliveries.
  const src = await db.one<SourceDetail>('SELECT * FROM lg.sources WHERE id = $1 FOR UPDATE', [sourceId]);
  const window = src.status === 'disabled' ? null : await openWindow(db, src.id, true);
  const stepUpdates: Partial<Record<StepName, { state: 'passed' | 'failed' | 'not_reached'; detail?: string }>> = { endpoint_reachable: { state: 'passed' } };
  const authStep: StepName = src.auth_mode === 'hmac_v1' ? 'signature_valid' : 'authentication_valid';

  const attempt = async (result: 'accepted' | 'duplicate' | 'rejected', reason: string | null, sourceEventId: string | null, dropped = 0) => {
    await db.q(
      `INSERT INTO lg.delivery_attempts (id, org_id, source_id, result, reason_code, source_event_id, body_sha256, dropped_fields, auth_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv7(), src.org_id, src.id, result, reason, sourceEventId, bodySha, dropped, src.auth_mode]);
  };

  const reject = async (status: number, code: string, reason: string, message: string, step?: StepName): Promise<{ response: IngestResponse }> => {
    await attempt('rejected', reason, null);
    if (window) {
      if (step) stepUpdates[step] = { state: 'failed', detail: stepDetail(reason) };
      await recordSteps(db, window.id, window.steps, stepUpdates);
    }
    // 3 consecutive rejected deliveries move a verified source to failing (Section 9.2).
    if (src.status === 'verified') {
      const last = await db.q<{ result: string }>('SELECT result FROM lg.delivery_attempts WHERE source_id = $1 ORDER BY received_at DESC, id DESC LIMIT 3', [src.id]);
      if (last.length === 3 && last.every(a => a.result === 'rejected')) {
        await db.q(`UPDATE lg.sources SET status = 'failing', version = version + 1 WHERE id = $1`, [src.id]);
        await emit(db, src.org_id, 'source.failing', { source_id: src.id });
      }
    }
    return { response: fail(rid, status, code, message) };
  };

  if (src.status === 'disabled') return reject(410, 'SOURCE_DISABLED', 'SOURCE_DISABLED', 'This source is disabled. Events are rejected.');
  if (raw.length > MAX_BODY) return reject(413, 'PAYLOAD_TOO_LARGE', 'PAYLOAD_TOO_LARGE', 'Body over 64 KB.');

  // ---------------------------------------------------------------- authentication per auth mode
  const keys = deps.config.sourceSecretKeys;
  const now = (await db.one<{ now: Date }>('SELECT now() AS now')).now;
  const secrets = (): string[] => {
    const cur = decryptSecret(src.secret_enc, keys);
    const prev = src.prev_secret_valid_until && src.prev_secret_valid_until > now ? decryptSecret(src.prev_secret_enc, keys) : null;
    return [cur, prev].filter((s): s is string => Boolean(s));
  };
  let corsOrigin: string | undefined;
  let parsed: Record<string, unknown> | null = null;

  if (family === 'calls') {
    const adapter = getCallAdapter(src.provider_key);
    if (!adapter || !deps.config.flags.call_sources) return reject(401, 'SIGNATURE_INVALID', 'CALL_PROVIDER_NOT_CONFIGURED', 'Signature verification failed.', authStep);
    if (!adapter.verify(raw, req.headers, secrets())) return reject(401, 'SIGNATURE_INVALID', 'SIGNATURE_INVALID', 'Signature verification failed.', authStep);
  } else if (src.auth_mode === 'hmac_v1') {
    const r = verifyV1({
      secrets: secrets(),
      timestampHeader: header(req, 'x-leadguard-timestamp'),
      signatureHeader: header(req, 'x-leadguard-signature'),
      rawBody: raw,
      nowSeconds: Math.floor(now.getTime() / 1000),
    });
    if (!r.ok) return reject(401, 'SIGNATURE_INVALID', r.reason, 'Signature verification failed.', authStep);
  } else if (src.auth_mode === 'secret_header') {
    if (!verifySecretHeader(secrets(), header(req, 'x-leadguard-source-secret'))) return reject(401, 'SIGNATURE_INVALID', 'SECRET_INVALID', 'Source secret verification failed.', authStep);
  } else {
    // embed: exact origin allowlist + server-verified bot challenge + honeypot (INT-005 BLOCKED -> flag off).
    const origin = header(req, 'origin');
    if (!deps.config.flags.embed_sources || !deps.botChallenge.configured) return reject(403, 'ORIGIN_NOT_ALLOWED', 'EMBED_NOT_ENABLED', 'Embed submissions are not enabled.', authStep);
    if (!origin || !src.allowed_origins.includes(origin)) return reject(403, 'ORIGIN_NOT_ALLOWED', 'ORIGIN_NOT_ALLOWED', 'Origin not allowed.', authStep);
    corsOrigin = origin;
    parsed = parseJson(raw);
    if (parsed && parsed[HONEYPOT_FIELD]) return reject(403, 'ORIGIN_NOT_ALLOWED', 'HONEYPOT_FILLED', 'Submission rejected.', authStep);
    const token = header(req, 'x-leadguard-challenge') ?? (typeof parsed?.[CHALLENGE_FIELD] === 'string' ? parsed[CHALLENGE_FIELD] as string : undefined);
    if (!(await deps.botChallenge.verify(token, req.ip))) return reject(403, 'ORIGIN_NOT_ALLOWED', 'CHALLENGE_FAILED', 'Challenge failed.', authStep);
  }
  stepUpdates[authStep] = { state: 'passed' };

  // ---------------------------------------------------------------- validate + normalize
  parsed = parsed ?? parseJson(raw);
  if (!parsed) return reject(400, 'VALIDATION_FAILED', 'VALIDATION_FAILED', 'Body must be a JSON object.', 'fields_mapped');
  const s = await loadOrgSettings(db, src.org_id);

  let name: string | null, emailRaw: string | null, phoneInput: string | null, message: string | null;
  let attributes: Record<string, string> = {};
  let dropped = 0;
  let dedupeKey: string;
  let occurredAt: Date;
  let call: null | { answered: boolean; voicemail: boolean; durationSeconds: number; classification: string } = null;

  if (family === 'calls') {
    const m = getCallAdapter(src.provider_key)!.map(parsed);
    if (!m.ok) return reject(400, 'PAYLOAD_UNMAPPABLE', 'PAYLOAD_UNMAPPABLE', m.message, 'fields_mapped');
    const c = m.call;
    name = null; emailRaw = null; phoneInput = c.from; message = null;
    occurredAt = validDate(c.startedAt) ?? now;
    dedupeKey = providerDedupeKey('call', `${c.callId}:${c.eventType}`);
    const longAnswered = c.answered && c.durationSeconds > 30;
    call = { answered: c.answered, voicemail: c.voicemail, durationSeconds: c.durationSeconds, classification: longAnswered ? 'answered_call_logged' : (c.voicemail ? 'voicemail' : 'missed_call') };
    attributes = { call_direction: c.direction, call_duration_seconds: String(c.durationSeconds) };
  } else {
    const m = mapFormPayload(parsed, src.field_mapping ?? {});
    ({ name, email: emailRaw, phone: phoneInput, message } = m.canonical);
    attributes = m.attributes;
    dropped = m.dropped;
    occurredAt = validDate(m.canonical.submitted_at) ?? now;
    dedupeKey = '';
    if (m.canonical.entry_id) dedupeKey = providerDedupeKey('form', m.canonical.entry_id);
  }
  const emailNorm = normalizeEmail(emailRaw);
  const phone = normalizePhone(phoneInput, s.country || 'US');
  if (!emailNorm && !phone.e164 && !phone.raw) {
    return reject(400, family === 'calls' ? 'PAYLOAD_UNMAPPABLE' : 'CONTACT_REQUIRED', 'CONTACT_REQUIRED', 'At least one of email or phone is required.', 'fields_mapped');
  }
  if (!dedupeKey) dedupeKey = hashDedupeKey(src.id, emailNorm, phone.e164, message, occurredAt.toISOString());
  name = name ? name.trim().slice(0, 200) : null;
  message = message ? message.slice(0, 4000) : null;
  stepUpdates.fields_mapped = { state: 'passed' };

  // ---------------------------------------------------------------- entitlement + verification gate (inside the transaction)
  const sub = await getSubscription(db, src.org_id, true);
  const state = effectiveState(sub, now);
  if (state === 'read_only') return reject(423, 'SUBSCRIPTION_INACTIVE', 'SUBSCRIPTION_INACTIVE', 'Subscription inactive.');
  const isTest = Boolean(window);
  if (!isTest && (src.status === 'draft' || src.status === 'testing' || state === 'setup_pending')) {
    return reject(409, 'SOURCE_NOT_VERIFIED', 'SOURCE_NOT_VERIFIED', 'This source is not verified. Start a verification window and send a test event.');
  }

  // ---------------------------------------------------------------- dedupe + match + create/link
  const eventId = uuidv7();
  let outcome: 'lead_created' | 'lead_linked' | 'activity_logged' = 'lead_created';
  let leadId: string | null = uuidv7();
  let possibleDuplicates: string[] = [];
  if (!isTest) {
    const candidates = await db.q<{ id: string; by: string }>(
      `SELECT id, CASE WHEN $1::text IS NOT NULL AND phone_e164 = $1 THEN 'phone' ELSE 'email' END AS by FROM lg.leads
        WHERE status IN ('new','attempted','contacted','qualified') AND NOT is_test
          AND created_at > now() - make_interval(days => $3)
          AND (($1::text IS NOT NULL AND phone_e164 = $1) OR ($2::text IS NOT NULL AND email_norm = $2))
        ORDER BY created_at DESC LIMIT 10`, [phone.e164, emailNorm, MATCH_DAYS]);
    const distinct = [...new Set(candidates.map(c => c.id))];
    if (distinct.length === 1) { outcome = 'lead_linked'; leadId = distinct[0]; }
    else if (distinct.length > 1) possibleDuplicates = distinct;
  }
  if (call?.classification === 'answered_call_logged') {
    // Answered calls over 30 s are contact activity on the matching open lead, never a new lead (API-021).
    const matched = outcome === 'lead_linked' ? leadId : null;
    outcome = 'activity_logged';
    leadId = matched;
  }

  const inserted = await db.maybe<{ id: string }>(
    `INSERT INTO lg.source_events (id, org_id, source_id, dedupe_key, kind, occurred_at, outcome, lead_id, is_test)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (source_id, dedupe_key) DO NOTHING RETURNING id`,
    [eventId, src.org_id, src.id, dedupeKey, family === 'calls' ? 'call' : 'form_submission', occurredAt, outcome, leadId, isTest]);

  if (!inserted) {
    // Duplicate delivery: replay the original outcome; no second lead, timer or alert (SRC-05, DB-08).
    const orig = await db.one<{ id: string; outcome: string; lead_id: string | null }>(
      'SELECT id, outcome, lead_id FROM lg.source_events WHERE source_id = $1 AND dedupe_key = $2', [src.id, dedupeKey]);
    await attempt('duplicate', null, orig.id, dropped);
    await db.q('UPDATE lg.sources SET last_event_at = now() WHERE id = $1', [src.id]);
    return { response: ok(rid, 200, { outcome: orig.outcome, event_id: orig.id, lead_id: orig.lead_id, duplicate: true }), corsOrigin };
  }

  const actor = { type: 'source' as const, id: `source:${src.id}` };
  let status = 201;
  if (outcome === 'lead_created') {
    await createLead(db, s, {
      leadId: leadId!, sourceId: src.id, name, emailNorm, phoneE164: phone.e164, phoneRaw: phone.raw, message, attributes, isTest,
      nextAction: call ? 'Return missed call' : 'First call', possibleDuplicates, actor, requestId: rid,
    }, now);
  } else if (outcome === 'lead_linked') {
    status = 200;
    await db.q('UPDATE lg.leads SET updated_at = now() WHERE id = $1', [leadId]);
    await audit(db, { orgId: src.org_id, actorType: 'source', actorId: actor.id, action: 'lead.repeat_enquiry', recordType: 'lead', recordId: leadId, requestId: rid });
    await emit(db, src.org_id, 'lead.repeat_enquiry', { lead_id: leadId, source_event_id: eventId });
  } else {
    status = 200;
    if (leadId) {
      const lead = await db.one<any>('SELECT id, status, first_action_at, next_action, due_at, version FROM lg.leads WHERE id = $1 FOR UPDATE', [leadId]);
      await applyActivity(db, s, lead, { type: 'call', outcome: 'reached', note: `Answered call (${call!.durationSeconds} s)`, actorId: null, occurredAt, evidence: 'provider_confirmed' });
      await audit(db, { orgId: src.org_id, actorType: 'source', actorId: actor.id, action: 'lead.call_logged', recordType: 'lead', recordId: leadId, requestId: rid });
    }
  }
  await attempt('accepted', null, eventId, dropped);
  stepUpdates.lead_created = { state: 'passed' };

  // Source health: an accepted event returns a failing source to verified.
  await db.q(`UPDATE lg.sources SET last_event_at = now(), status = CASE WHEN status = 'failing' THEN 'verified' ELSE status END WHERE id = $1`, [src.id]);
  if (src.status === 'failing') await emit(db, src.org_id, 'source.verified', { source_id: src.id });

  if (window) await verify(db, deps, src, window, stepUpdates, state, now, rid);

  const body: Record<string, unknown> = { outcome, event_id: eventId, lead_id: leadId, duplicate: false };
  if (call) body.classification = call.classification;
  if (isTest) body.test = true;
  return { response: ok(rid, status, body), corsOrigin };
}

/** First valid event inside a window: source -> verified; setup_pending -> trialing in the same transaction. */
async function verify(db: Db, deps: Deps, src: SourceDetail, window: OpenWindow, stepUpdates: any, state: string, now: Date, rid: string) {
  await recordSteps(db, window.id, window.steps, stepUpdates);
  await db.q(`UPDATE lg.verification_windows SET result = 'passed' WHERE id = $1`, [window.id]);
  await db.q(`UPDATE lg.sources SET status = 'verified', verified_at = now(), version = version + 1 WHERE id = $1`, [src.id]);
  await audit(db, { orgId: src.org_id, actorType: 'source', actorId: `source:${src.id}`, action: 'source.verified', recordType: 'source', recordId: src.id, requestId: rid });
  await emit(db, src.org_id, 'source.verified', { source_id: src.id });
  if (state === 'setup_pending') {
    const trialEnds = new Date(now.getTime() + deps.config.plans.trialDays * 86_400_000);
    await db.q(`UPDATE lg.subscriptions SET state = 'trialing', trial_started_at = $2, trial_ends_at = $3, version = version + 1, updated_at = now() WHERE org_id = $1`,
      [src.org_id, now, trialEnds]);
    await audit(db, { orgId: src.org_id, actorType: 'system', actorId: null, action: 'billing.trial_started', recordType: 'subscription', recordId: src.org_id, requestId: rid });
    await emit(db, src.org_id, 'billing.subscription_changed', { from_state: 'setup_pending', to_state: 'trialing' });
  }
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
}

function parseJson(raw: Buffer): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function validDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

