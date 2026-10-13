// API-001 Service health and API-002 Current user.
import type { FastifyInstance } from 'fastify';
import { getOperation } from '@leadguard/contracts';
import { withoutOrg } from '@leadguard/db';
import { permissionsFor } from '@leadguard/domain';
import type { Deps } from '../deps.ts';
import { defineRoute, registeredOperations } from '../lib/route.ts';
import { effectiveState, getSubscription } from '@leadguard/db';

export function registerSystem(app: FastifyInstance, deps: Deps): void {
  // API-001: 200 ready/degraded while PostgreSQL is reachable; 503 only when it is not (DEC-008).
  const op = getOperation('API-001');
  registeredOperations().add(op.id);
  app.get(op.path, { config: { operationId: op.id, entitlement: op.entitlement } }, async (_req, reply) => {
    let stats: { outbox_lag_seconds: number; oldest_pending_timer_seconds: number } | null = null;
    try {
      stats = await withoutOrg(deps.pool, db => db.one('SELECT outbox_lag_seconds, oldest_pending_timer_seconds FROM lg.health_stats()'));
    } catch {
      return reply.code(503).send({ status: 'unavailable', checks: { postgres: 'unavailable' }, version: deps.config.version });
    }
    const redisOk = deps.redis ? await deps.redis.ping() : false;
    return reply.code(200).send({
      status: redisOk ? 'ready' : 'degraded',
      checks: { postgres: 'ok', redis: redisOk ? 'ok' : 'unavailable', outbox_lag_seconds: stats!.outbox_lag_seconds, oldest_pending_timer_seconds: stats!.oldest_pending_timer_seconds },
      version: deps.config.version,
    });
  });

  defineRoute(app, deps, {
    op: 'API-002',
    orgOptional: true,
    handler: async ctx => {
      const a = ctx.actor;
      const orgs = await withoutOrg(deps.pool, db => db.q<{ org_id: string; name: string; time_zone: string; role: string; status: string }>(
        'SELECT org_id, name, time_zone, role, status FROM lg.user_organizations($1)', [a.userId]));
      const active = orgs.filter(o => o.status === 'active');
      let activeOrg = null, subscriptionState = null, setupComplete = false;
      if (a.orgId) {
        const o = a.support ? await ctx.db.one('SELECT id, name, time_zone FROM lg.organizations WHERE id = $1', [a.orgId]) : null;
        const cur = active.find(x => x.org_id === a.orgId);
        activeOrg = { id: a.orgId, name: cur?.name ?? o?.name, role: a.support ? 'support' : a.role, time_zone: cur?.time_zone ?? o?.time_zone };
        subscriptionState = effectiveState(await getSubscription(ctx.db, a.orgId), ctx.now);
        const verified = await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM lg.sources WHERE status IN ('verified','failing')`);
        const team = await ctx.db.one<{ n: number }>(
          `SELECT (SELECT count(*) FROM lg.memberships) + (SELECT count(*) FROM lg.invitations WHERE status IN ('pending','accepted')) - 1 AS n`);
        setupComplete = verified.n > 0 && team.n > 0;
      }
      return {
        data: {
          user: { id: a.userId, name: a.name, email: a.email },
          active_org: activeOrg,
          organizations: active.map(o => ({ id: o.org_id, name: o.name, role: o.role })),
          permissions: a.support ? a.permissions : (a.role ? permissionsFor(a.role) : []),
          subscription_state: subscriptionState,
          setup_complete: setupComplete,
        },
      };
    },
  });
}
