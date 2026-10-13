// API-012..019 Sources and verification. A source shows Connected only when `verified` (Section 9.2).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError, createSourceBody, disableSourceBody, emptyBody, findPlan, isoOrNull, isoSeconds, sourceEventsQuery, testEventBody, uuid,
} from '@leadguard/contracts';
import { uuidv7 } from '@leadguard/domain';
import { emit, getSubscription, loadOrgSettings, type Db } from '@leadguard/db';
import { getCallAdapter } from '@leadguard/adapters';
import type { Deps } from '../deps.ts';
import { defineRoute, type OpResult } from '../lib/route.ts';
import { encryptSecret, newSigningSecret, newSourceKey } from '../lib/crypto.ts';
import { planLimitError, usage } from '../lib/usage.ts';
import { initialSteps, openWindow } from '../lib/verification.ts';

const sourceParams = z.object({ sourceId: uuid });

interface SourceRow {
  id: string; name: string; type: string; status: string; auth_mode: string; source_key: string; last_event_at: Date | null;
  verified_at: Date | null; disabled_at: Date | null; allowed_origins: string[]; field_mapping: Record<string, string>; version: number;
}

async function loadSource(db: Db, id: string, lock = false): Promise<SourceRow> {
  const s = await db.maybe<SourceRow>(`SELECT * FROM lg.sources WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!s) throw new AppError('NOT_FOUND', 'Source not found.');
  return s;
}

/** 24-hour delivery counts for many sources in one grouped query. */
async function counts24h(db: Db, ids: string[]): Promise<Map<string, { accepted: number; duplicate: number; rejected: number }>> {
  const rows = await db.q<{ source_id: string; accepted: number; duplicate: number; rejected: number }>(
    `SELECT source_id,
            count(*) FILTER (WHERE result = 'accepted')::int AS accepted,
            count(*) FILTER (WHERE result = 'duplicate')::int AS duplicate,
            count(*) FILTER (WHERE result IN ('rejected','failed'))::int AS rejected
       FROM lg.delivery_attempts WHERE source_id = ANY($1::uuid[]) AND received_at > now() - interval '24 hours'
      GROUP BY source_id`, [ids]);
  return new Map(rows.map(r => [r.source_id, { accepted: r.accepted, duplicate: r.duplicate, rejected: r.rejected }]));
}

/** Most recent rejection per failing source, with the count of consecutive rejections. */
async function lastErrors(db: Db, ids: string[]): Promise<Map<string, { reason: string; at: string; count: number }>> {
  if (!ids.length) return new Map();
  const rows = await db.q<{ source_id: string; reason_code: string; received_at: Date; n: number }>(
    `SELECT DISTINCT ON (a.source_id) a.source_id, a.reason_code, a.received_at,
            (SELECT count(*)::int FROM lg.delivery_attempts b
              WHERE b.source_id = a.source_id AND b.result IN ('rejected','failed')
                AND b.received_at > coalesce((SELECT max(c.received_at) FROM lg.delivery_attempts c WHERE c.source_id = a.source_id AND c.result IN ('accepted','duplicate')), '-infinity')) AS n
       FROM lg.delivery_attempts a
      WHERE a.source_id = ANY($1::uuid[]) AND a.result IN ('rejected','failed')
      ORDER BY a.source_id, a.received_at DESC`, [ids]);
  return new Map(rows.map(r => [r.source_id, { reason: r.reason_code, at: isoSeconds(r.received_at), count: r.n }]));
}

function endpointUrl(deps: Deps, s: { type: string; source_key: string }): string {
  const family = s.type === 'call_webhook' ? 'calls' : 'forms';
  return `${deps.config.apiUrl.replace(/\/$/, '')}/ingest/v1/${family}/${s.source_key}`;
}

/** R-IDEM-3: a replayed response never contains the secret. */
const redactSecret = (next: string) => (r: OpResult): OpResult => {
  const d = { ...(r.data as Record<string, unknown>) };
  if (!('signing_secret' in d) || d.signing_secret === undefined) return r;
  d.signing_secret = null;
  d.secret_available = false;
  delete d.signature;
  if ('next_step' in d) d.next_step = next;
  return { ...r, status: r.status, message: 'Source already created. The secret is shown only once; rotate it if it was not copied.', data: d };
};

export function registerSources(app: FastifyInstance, deps: Deps): void {
  // API-012 List sources.
  defineRoute(app, deps, {
    op: 'API-012',
    permission: ['sources.manage', 'dashboard.read'],
    permissionMessage: 'Only owners and managers can manage sources.',
    handler: async ctx => {
      const rows = await ctx.db.q<SourceRow>('SELECT * FROM lg.sources ORDER BY created_at, id');
      const ids = rows.map(r => r.id);
      const c = await counts24h(ctx.db, ids);
      const errs = await lastErrors(ctx.db, rows.filter(r => r.status === 'failing').map(r => r.id));
      return {
        data: {
          items: rows.map(r => {
            const item: Record<string, unknown> = {
              id: r.id, name: r.name, type: r.type, status: r.status, last_event_at: isoOrNull(r.last_event_at),
            };
            if (r.verified_at) item.verified_at = isoSeconds(r.verified_at);
            if (r.status === 'failing' && errs.get(r.id)) item.last_error = errs.get(r.id);
            else item.events_24h = c.get(r.id) ?? { accepted: 0, duplicate: 0, rejected: 0 };
            return item;
          }),
        },
      };
    },
  });

  // API-013 Create source. Secret: 32 random bytes, AES-256-GCM encrypted, shown once.
  defineRoute(app, deps, {
    op: 'API-013',
    body: createSourceBody,
    permission: 'sources.manage',
    permissionMessage: 'Only owners and managers can manage sources.',
    redactForReplay: redactSecret('rotate_secret_if_not_copied'),
    handler: async ctx => {
      const b = ctx.body;
      const flags = deps.config.flags;
      let authMode: string;
      if (b.type === 'web_form_webhook') {
        authMode = b.auth_mode ?? 'hmac_v1';
        if (authMode === 'embed') throw new AppError('VALIDATION_FAILED', 'Webhook sources use hmac_v1 or secret_header.', { fields: { auth_mode: 'Use hmac_v1 or secret_header.' } });
      } else if (b.type === 'web_form_embed') {
        if (!flags.embed_sources || !deps.botChallenge.configured) {
          throw new AppError('SOURCE_TYPE_NOT_ENABLED', 'Website embed forms are not enabled yet. Use a webhook from your form tool.', { type: b.type });
        }
        if (!b.allowed_origins?.length) throw new AppError('VALIDATION_FAILED', 'Embed sources need at least one allowed website origin.', { fields: { allowed_origins: 'Add the exact https origin of your website.' } });
        authMode = 'embed';
      } else {
        if (!flags.call_sources || !getCallAdapter(b.provider_key)) {
          throw new AppError('SOURCE_TYPE_NOT_ENABLED', 'Call sources are enabled only after the provider is verified for your account.', { type: b.type });
        }
        authMode = 'hmac_v1';
      }
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const sub = await getSubscription(ctx.db, ctx.orgId);
      const u = await usage(ctx.db, s.timeZone, ctx.now);
      const max = findPlan(deps.config.plans, sub.plan_id).limits.sources;
      if (u.sources >= max) throw planLimitError('sources', u.sources, max);

      const id = uuidv7();
      const key = newSourceKey();
      const secret = authMode === 'embed' ? null : newSigningSecret();
      await ctx.db.q(
        `INSERT INTO lg.sources (id, org_id, type, name, source_key, auth_mode, secret_enc, allowed_origins, field_mapping, provider_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, ctx.orgId, b.type, b.name, key, authMode, secret ? encryptSecret(secret, deps.config.sourceSecretKeys) : null,
          b.allowed_origins ?? [], JSON.stringify(b.field_mapping ?? {}), b.type === 'call_webhook' ? b.provider_key : null]);
      await ctx.audit('source.created', 'source', id);
      await emit(ctx.db, ctx.orgId, 'source.created', { source_id: id });
      const endpoint = endpointUrl(deps, { type: b.type, source_key: key });
      const data: Record<string, unknown> = { source: { id, type: b.type, status: 'draft' }, endpoint_url: endpoint };
      if (authMode === 'embed') {
        data.embed_snippet = `<script src="${deps.config.apiUrl.replace(/\/$/, '')}/embed/v1/form.js" data-source-key="${key}" async></script>`;
      } else {
        data.signing_secret = secret;
        data.auth_mode = authMode;
        data.signature = authMode === 'hmac_v1'
          ? { header: 'X-LeadGuard-Signature', timestamp_header: 'X-LeadGuard-Timestamp', algorithm: 'HMAC-SHA256', signed_payload: '{timestamp}.{raw_body}' }
          : { header: 'X-LeadGuard-Source-Secret', algorithm: 'shared-secret' };
      }
      data.next_step = 'send_test_event';
      return { status: 201, message: secret ? 'Source created. Copy the secret now; it will not be shown again.' : 'Source created. Add the snippet to your website.', data };
    },
  });

  // API-014 Read source and verification state (polled by setup every 3 s).
  defineRoute(app, deps, {
    op: 'API-014',
    params: sourceParams,
    permission: 'sources.manage',
    permissionMessage: 'Only owners and managers can manage sources.',
    handler: async ctx => {
      const s = await loadSource(ctx.db, ctx.params.sourceId);
      const c = (await counts24h(ctx.db, [s.id])).get(s.id) ?? { accepted: 0, duplicate: 0, rejected: 0 };
      await openWindow(ctx.db, s.id);
      const w = await ctx.db.maybe<{ opened_at: Date; expires_at: Date; steps: any[]; result: string }>(
        'SELECT opened_at, expires_at, steps, result FROM lg.verification_windows WHERE source_id = $1 ORDER BY opened_at DESC LIMIT 1', [s.id]);
      const data: Record<string, unknown> = {
        id: s.id, name: s.name, type: s.type, status: s.status, auth_mode: s.auth_mode,
        endpoint_url: endpointUrl(deps, s),
        last_event_at: isoOrNull(s.last_event_at), verified_at: isoOrNull(s.verified_at), events_24h: c,
        verification: w ? { started_at: isoSeconds(w.opened_at), expires_at: isoSeconds(w.expires_at), result: w.result, steps: w.steps.length ? w.steps : initialSteps(s.auth_mode) } : null,
      };
      if (s.status === 'failing') data.last_error = (await lastErrors(ctx.db, [s.id])).get(s.id) ?? null;
      return { data };
    },
  });

  // API-015 Start source verification: open a window; LeadGuard never sends a synthetic event.
  defineRoute(app, deps, {
    op: 'API-015',
    params: sourceParams,
    body: testEventBody,
    permission: 'sources.manage',
    permissionMessage: 'Only owners and managers can manage sources.',
    handler: async ctx => {
      const s = await loadSource(ctx.db, ctx.params.sourceId, true);
      if (s.status === 'disabled') throw new AppError('SOURCE_DISABLED', 'Enable this source before testing it.');
      const instructions = s.type === 'call_webhook'
        ? 'Call your business number once and hang up. It will appear in your inbox marked TEST.'
        : 'Submit your website form once with a real-looking enquiry. It will appear in your inbox marked TEST.';
      let w = await openWindow(ctx.db, s.id, true);
      if (!w) {
        const id = uuidv7();
        const expires = new Date(ctx.now.getTime() + ctx.body.window_minutes * 60_000);
        await ctx.db.q('INSERT INTO lg.verification_windows (id, org_id, source_id, expires_at, steps) VALUES ($1,$2,$3,$4,$5)',
          [id, ctx.orgId, s.id, expires, JSON.stringify(initialSteps(s.auth_mode))]);
        w = { id, steps: initialSteps(s.auth_mode), expires_at: expires, opened_at: ctx.now };
        await ctx.audit('source.verification_started', 'source', s.id);
      }
      let status = s.status;
      if (s.status === 'draft') {
        await ctx.db.q(`UPDATE lg.sources SET status = 'testing', version = version + 1 WHERE id = $1`, [s.id]);
        status = 'testing';
      }
      return {
        status: 202,
        message: 'Waiting for your test event.',
        data: { source_id: s.id, status: status === 'draft' ? 'testing' : status, verification_id: w.id, expires_at: isoSeconds(w.expires_at), instructions },
      };
    },
  });

  // API-016 Source delivery log: outcome and reason only, no contact data.
  defineRoute(app, deps, {
    op: 'API-016',
    params: sourceParams,
    query: sourceEventsQuery,
    permission: 'sources.manage',
    permissionMessage: 'Only owners and managers can manage sources.',
    handler: async ctx => {
      await loadSource(ctx.db, ctx.params.sourceId);
      const q = ctx.query;
      const after = ctx.deps.cursors.decode(ctx.orgId, `API-016:${ctx.params.sourceId}`, q.cursor);
      const rows = await ctx.db.q<{ id: string; received_at: Date; result: string; reason_code: string | null; lead_id: string | null; dedupe_key: string | null; auth_mode: string | null }>(
        `SELECT a.id, a.received_at, a.result, a.reason_code, a.auth_mode, e.lead_id, e.dedupe_key
           FROM lg.delivery_attempts a LEFT JOIN lg.source_events e ON e.id = a.source_event_id
          WHERE a.source_id = $1 AND ($2::text IS NULL OR a.result = $2)
            AND ($3::timestamptz IS NULL OR (a.received_at, a.id) < ($3::timestamptz, $4::uuid))
          ORDER BY a.received_at DESC, a.id DESC LIMIT $5`,
        [ctx.params.sourceId, q.outcome ?? null, after?.[0] ?? null, after?.[1] ?? null, q.limit + 1]);
      const more = rows.length > q.limit;
      const items = rows.slice(0, q.limit).map(r => ({
        event_id: r.id, received_at: isoSeconds(r.received_at), outcome: r.result, reason: r.reason_code,
        lead_id: r.lead_id, dedupe_key: r.dedupe_key, auth_mode: r.auth_mode,
      }));
      const last = rows[q.limit - 1];
      return { data: { items, next_cursor: more ? ctx.deps.cursors.encode(ctx.orgId, `API-016:${ctx.params.sourceId}`, [last.received_at.toISOString(), last.id]) : null } };
    },
  });

  // API-017 Rotate signing secret: previous secret stays valid for 24 hours.
  defineRoute(app, deps, {
    op: 'API-017',
    params: sourceParams,
    body: emptyBody,
    permission: 'sources.manage',
    permissionMessage: 'Only owners and managers can manage sources.',
    redactForReplay: r => {
      const d = { ...(r.data as Record<string, unknown>), signing_secret: null, secret_available: false };
      return { ...r, message: 'Secret already rotated. The new secret is shown only once; rotate again if it was not copied.', data: d };
    },
    handler: async ctx => {
      const s = await ctx.db.maybe<SourceRow & { secret_enc: Buffer | null }>('SELECT * FROM lg.sources WHERE id = $1 FOR UPDATE', [ctx.params.sourceId]);
      if (!s) throw new AppError('NOT_FOUND', 'Source not found.');
      if (s.auth_mode === 'embed') throw new AppError('NOT_APPLICABLE', 'Embed sources do not use a signing secret.');
      const secret = newSigningSecret();
      const validUntil = new Date(ctx.now.getTime() + 24 * 3600_000);
      await ctx.db.q(
        `UPDATE lg.sources SET prev_secret_enc = secret_enc, prev_secret_valid_until = $2, secret_enc = $3, version = version + 1 WHERE id = $1`,
        [s.id, validUntil, encryptSecret(secret, deps.config.sourceSecretKeys)]);
      await ctx.audit('source.secret_rotated', 'source', s.id, ['secret']);
      await emit(ctx.db, ctx.orgId, 'source.secret_rotated', { source_id: s.id, previous_valid_until: validUntil.toISOString() });
      return {
        message: 'New secret created. Update your form tool within 24 hours.',
        data: { source_id: s.id, signing_secret: secret, previous_secret_valid_until: isoSeconds(validUntil) },
      };
    },
  });

  // API-018 Disable source (control: allowed in every subscription state).
  defineRoute(app, deps, {
    op: 'API-018',
    params: sourceParams,
    body: disableSourceBody,
    permission: 'sources.manage',
    permissionMessage: 'Only owners and managers can disable sources.',
    handler: async ctx => {
      const s = await loadSource(ctx.db, ctx.params.sourceId, true);
      if (s.status !== 'disabled') {
        await ctx.db.q(`UPDATE lg.sources SET status = 'disabled', disabled_at = $2, version = version + 1 WHERE id = $1`, [s.id, ctx.now]);
        await ctx.db.q(`UPDATE lg.verification_windows SET result = 'expired' WHERE source_id = $1 AND result = 'open'`, [s.id]);
        await ctx.audit('source.disabled', 'source', s.id, ['status']);
        await emit(ctx.db, ctx.orgId, 'source.disabled', { source_id: s.id });
      }
      return { message: 'Source disabled. New events will be rejected.', data: { source_id: s.id, status: 'disabled', disabled_at: isoSeconds(s.disabled_at ?? ctx.now) } };
    },
  });

  // API-019 Re-enable source: back to `testing`, never directly to `verified`.
  defineRoute(app, deps, {
    op: 'API-019',
    params: sourceParams,
    body: emptyBody,
    permission: 'sources.manage',
    permissionMessage: 'Only owners and managers can manage sources.',
    handler: async ctx => {
      const s = await loadSource(ctx.db, ctx.params.sourceId, true);
      if (s.status !== 'disabled') {
        return { message: 'Source is already enabled.', data: { source_id: s.id, status: s.status, next_step: s.status === 'verified' ? null : 'send_test_event' } };
      }
      const st = await loadOrgSettings(ctx.db, ctx.orgId);
      const sub = await getSubscription(ctx.db, ctx.orgId);
      const u = await usage(ctx.db, st.timeZone, ctx.now);
      const max = findPlan(deps.config.plans, sub.plan_id).limits.sources;
      if (u.sources >= max) throw planLimitError('sources', u.sources, max);
      await ctx.db.q(`UPDATE lg.sources SET status = 'testing', disabled_at = NULL, version = version + 1 WHERE id = $1`, [s.id]);
      await ctx.audit('source.enabled', 'source', s.id, ['status']);
      await emit(ctx.db, ctx.orgId, 'source.enabled', { source_id: s.id });
      return { message: 'Source enabled. Send a test enquiry to reconnect it.', data: { source_id: s.id, status: 'testing', next_step: 'send_test_event' } };
    },
  });
}
