// Operation runner shared by every /api/v1 route (TASK-004): envelope, validation, permission, idempotency
// (R-IDEM-1..4), entitlement inside the write transaction, audit of support access.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import { withOrg, setContext, dbNow, assertEntitled, audit, type Db, type AuditInput } from '@leadguard/db';
import { AppError, getOperation, successEnvelope, type Operation } from '@leadguard/contracts';
import type { Permission } from '@leadguard/domain';
import type { Actor } from '../plugins/auth.ts';
import type { Deps } from '../deps.ts';
import { requestHash } from './crypto.ts';
import { zodToValidation } from './validation.ts';
import { assertSafeInput } from './input-safety.ts';
import { enforce } from './rate-limit.ts';

export interface OpContext<B = any, Q = any, P = any> {
  db: Db;
  deps: Deps;
  actor: Actor;
  /** Active organization (asserted non-null unless the route sets orgOptional). */
  orgId: string;
  userId: string;
  body: B;
  query: Q;
  params: P;
  now: Date;
  requestId: string;
  req: FastifyRequest;
  op: Operation;
  /** Audit helper that fills actor, request ID and support grant. */
  audit(action: string, recordType?: string | null, recordId?: string | null, changedFields?: string[] | null): Promise<void>;
  /** Change org context inside the transaction (bootstrap flows). */
  switchOrg(orgId: string): Promise<void>;
}

export interface OpResult {
  status?: number;
  message?: string;
  data: unknown;
  headers?: Record<string, string>;
}

export interface RouteSpec<B extends ZodType | undefined, Q extends ZodType | undefined, P extends ZodType | undefined> {
  op: string;
  body?: B;
  query?: Q;
  params?: P;
  /** Any-of permission check before the transaction (object-level checks happen in the handler). */
  permission?: Permission | Permission[];
  permissionMessage?: string;
  orgOptional?: boolean;
  /** R-IDEM-3: transform a stored response before it is written to idempotency_keys (secrets removed). */
  redactForReplay?: (r: OpResult) => OpResult;
  /** Idempotency scope override (API-003 runs before any organization exists: scope = the user). */
  idempotencyScope?: (actor: Actor) => string;
  handler: (ctx: OpContext<
    B extends ZodType ? z.infer<B> : undefined,
    Q extends ZodType ? z.infer<Q> : undefined,
    P extends ZodType ? z.infer<P> : undefined>) => Promise<OpResult>;
}

const registered = new Set<string>();

export function registeredOperations(): Set<string> {
  return registered;
}

function parse<T extends ZodType>(schema: T | undefined, value: unknown): any {
  if (!schema) return undefined;
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw zodToValidation(r.error);
  return r.data;
}

const IDEM_KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;

export function defineRoute<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(
  app: FastifyInstance, deps: Deps, spec: RouteSpec<B, Q, P>,
): void {
  const op = getOperation(spec.op);
  if (registered.has(op.id)) throw new Error(`${op.id} registered twice`);
  registered.add(op.id);

  app.route({
    method: op.method,
    url: op.path,
    config: { operationId: op.id, entitlement: op.entitlement },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = req.actor;
      if (!actor) throw new AppError('AUTHENTICATION_REQUIRED', 'Your session has expired. Sign in again.');
      if (!spec.orgOptional && !actor.orgId) throw new AppError('NOT_FOUND', 'Organization not found.');

      // Support grants with read_only scope can only use read operations (Section 28, API-051).
      if (actor.support?.scope === 'read_only' && op.entitlement !== 'read') {
        throw new AppError('AUTHORIZATION_DENIED', 'Support access is read-only.');
      }
      if (spec.permission) {
        const any = Array.isArray(spec.permission) ? spec.permission : [spec.permission];
        if (!any.some(p => actor.permissions.includes(p))) throw new AppError('AUTHORIZATION_DENIED', spec.permissionMessage ?? 'You do not have permission to do this.');
      }

      await enforce(deps.limiter, `user:${actor.userId}`, deps.config.rateLimits.userPerMinute, 60);
      assertSafeInput(req.body, 'body');
      assertSafeInput(req.query, 'query');
      const params = parse(spec.params, req.params);
      const query = parse(spec.query, req.query);
      const body = parse(spec.body, req.body);

      const scopeOrg = spec.idempotencyScope ? spec.idempotencyScope(actor) : actor.orgId!;
      let idemKey: string | null = null;
      let hash: Buffer | null = null;
      if (op.idempotency) {
        const k = req.headers['idempotency-key'];
        if (typeof k !== 'string' || !IDEM_KEY_RE.test(k)) {
          throw new AppError('VALIDATION_FAILED', 'An Idempotency-Key header (8-100 characters) is required.', { fields: { 'Idempotency-Key': 'Required, 8-100 characters.' } });
        }
        idemKey = k;
        hash = requestHash({ params: req.params, body: req.body ?? null });
        const replay = await reserveKey(deps, scopeOrg, actor.userId, op.path, idemKey, hash);
        if (replay) {
          const status = replay.code === 201 ? 200 : replay.code;
          return reply.code(status).send(successEnvelope(replay.body.data, req.requestId, replay.body.message ?? undefined));
        }
      }

      try {
        const result = await withOrg(deps.pool, actor.orgId, actor.userId, async db => {
          const now = await dbNow(db);
          const ctx: OpContext = {
            db, deps, actor, orgId: actor.orgId!, userId: actor.userId, body, query, params, now, requestId: req.requestId, req, op,
            async audit(action, recordType, recordId, changedFields) {
              const a: AuditInput = {
                orgId: ctx.orgId, actorType: actor.support ? 'support' : 'user', actorId: actor.userId, action,
                recordType: recordType ?? null, recordId: recordId ?? null, changedFields: changedFields ?? null,
                supportGrantId: actor.support?.grantId ?? null, requestId: req.requestId,
              };
              await audit(db, a);
            },
            async switchOrg(orgId: string) {
              ctx.orgId = orgId;
              await setContext(db, orgId, actor.userId);
            },
          };
          if (actor.orgId && op.entitlement !== 'none') await assertEntitled(db, actor.orgId, op.entitlement, now);
          if (actor.support) {
            await audit(db, { orgId: actor.orgId!, actorType: 'support', actorId: actor.userId, action: 'support.request', recordType: op.id, supportGrantId: actor.support.grantId, requestId: req.requestId });
          }
          const r = await spec.handler(ctx as any);
          if (idemKey) {
            const stored = spec.redactForReplay ? spec.redactForReplay(r) : r;
            await setContext(db, scopeOrg, actor.userId);
            await db.q(
              `UPDATE lg.idempotency_keys SET state = 'completed', response_code = $5, response_body = $6
                WHERE org_id = $1 AND actor_id = $2 AND route = $3 AND key = $4`,
              [scopeOrg, actor.userId, op.path, idemKey, stored.status ?? 200, JSON.stringify({ message: stored.message ?? null, data: stored.data })]);
          }
          return r;
        });
        for (const [h, v] of Object.entries(result.headers ?? {})) reply.header(h, v);
        return reply.code(result.status ?? 200).send(successEnvelope(result.data, req.requestId, result.message));
      } catch (e) {
        // R-IDEM-4: a request that fails before commit deletes its in-progress key so the client can retry.
        if (idemKey) await releaseKey(deps, scopeOrg, actor.userId, op.path, idemKey).catch(() => {});
        throw e;
      }
    },
  });
}

async function reserveKey(deps: Deps, orgId: string, actorId: string, route: string, key: string, hash: Buffer):
  Promise<{ code: number; body: { message: string | null; data: unknown } } | null> {
  return withOrg(deps.pool, orgId, actorId, async db => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ins = await db.maybe(
        `INSERT INTO lg.idempotency_keys (org_id, actor_id, route, key, request_hash, state, expires_at)
         VALUES ($1,$2,$3,$4,$5,'in_progress', now() + interval '24 hours')
         ON CONFLICT DO NOTHING RETURNING 1 AS ok`, [orgId, actorId, route, key, hash]);
      if (ins) return null;
      const row = await db.maybe<{ request_hash: Buffer; state: string; response_code: number; response_body: any; expired: boolean }>(
        `SELECT request_hash, state, response_code, response_body, expires_at < now() AS expired
           FROM lg.idempotency_keys WHERE org_id = $1 AND actor_id = $2 AND route = $3 AND key = $4 FOR UPDATE`,
        [orgId, actorId, route, key]);
      if (!row) continue;
      if (row.expired) {
        await db.q('DELETE FROM lg.idempotency_keys WHERE org_id = $1 AND actor_id = $2 AND route = $3 AND key = $4', [orgId, actorId, route, key]);
        continue;
      }
      if (!row.request_hash.equals(hash)) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
      }
      if (row.state === 'in_progress') {
        throw new AppError('REQUEST_IN_PROGRESS', 'The same request is still being processed. Try again in a moment.', {}, { retryable: true });
      }
      return { code: row.response_code, body: row.response_body };
    }
    throw new AppError('REQUEST_IN_PROGRESS', 'The same request is still being processed. Try again in a moment.', {}, { retryable: true });
  });
}

async function releaseKey(deps: Deps, orgId: string, actorId: string, route: string, key: string): Promise<void> {
  await withOrg(deps.pool, orgId, actorId, db =>
    db.q(`DELETE FROM lg.idempotency_keys WHERE org_id = $1 AND actor_id = $2 AND route = $3 AND key = $4 AND state = 'in_progress'`, [orgId, actorId, route, key]));
}

/** Startup guard: every registry operation has a route and no route lacks a registry entry. */
export function assertAllOperationsRegistered(expected: string[]): void {
  const missing = expected.filter(id => !registered.has(id));
  if (missing.length) throw new Error(`Operations without routes: ${missing.join(', ')}`);
}

/** Exposed for tests that build several app instances in one process. */
export function resetRegistry(): void {
  registered.clear();
}
