// API-050..052 Support access grants: time-bound (max 72 h, database CHECK), owner-approved, audited.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, emptyBody, grantBody, isoOrNull, isoSeconds, uuid } from '@leadguard/contracts';
import { uuidv7 } from '@leadguard/domain';
import { emit } from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';
import { names } from '../lib/present.ts';

function grantStatus(g: { revoked_at: Date | null; expires_at: Date; starts_at: Date }, now: Date): 'active' | 'expired' | 'revoked' | 'scheduled' {
  if (g.revoked_at) return 'revoked';
  if (g.expires_at <= now) return 'expired';
  if (g.starts_at > now) return 'scheduled';
  return 'active';
}

export function registerSupport(app: FastifyInstance, deps: Deps): void {
  defineRoute(app, deps, {
    op: 'API-050',
    permission: 'support.grant',
    permissionMessage: 'Only owners can manage support access.',
    handler: async ctx => {
      const rows = await ctx.db.q<any>(
        `SELECT g.*, (SELECT count(*)::int FROM lg.audit_events a WHERE a.support_grant_id = g.id AND a.action = 'support.request') AS accesses
           FROM lg.support_access_grants g ORDER BY g.starts_at DESC, g.id DESC LIMIT 200`);
      const nm = await names(ctx.db, rows.map(r => r.granted_by));
      return {
        data: {
          items: rows.map(g => ({
            grant_id: g.id, scope: g.scope, reason: g.reason, granted_by: nm.get(g.granted_by) ?? null,
            starts_at: isoSeconds(g.starts_at), expires_at: isoSeconds(g.expires_at), revoked_at: isoOrNull(g.revoked_at),
            status: grantStatus(g, ctx.now), accesses: g.accesses,
          })),
        },
      };
    },
  });

  defineRoute(app, deps, {
    op: 'API-051',
    body: grantBody,
    permission: 'support.grant',
    permissionMessage: 'Only owners can manage support access.',
    handler: async ctx => {
      if (ctx.actor.support) throw new AppError('AUTHORIZATION_DENIED', 'Only owners can manage support access.');
      const b = ctx.body;
      if (b.duration_hours > 72) throw new AppError('VALIDATION_FAILED', 'Support access can last at most 72 hours.', { fields: { duration_hours: 'At most 72.' } });
      if (b.scope === 'read_write' && b.confirm_read_write !== true) {
        throw new AppError('CONFIRMATION_REQUIRED', 'Read-write support access needs a second confirmation (confirm_read_write: true).');
      }
      const id = uuidv7();
      const expires = new Date(ctx.now.getTime() + b.duration_hours * 3600_000);
      await ctx.db.q('INSERT INTO lg.support_access_grants (id, org_id, scope, reason, granted_by, starts_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, ctx.orgId, b.scope, b.reason, ctx.userId, ctx.now, expires]);
      await ctx.audit('support.access_granted', 'support_grant', id);
      await emit(ctx.db, ctx.orgId, 'support.access_granted', { grant_id: id });
      const label = b.scope === 'read_only' ? 'read-only' : 'read and write';
      return {
        status: 201,
        message: `Support can view your account (${label}) for ${b.duration_hours} hour${b.duration_hours === 1 ? '' : 's'}.`,
        data: { grant_id: id, scope: b.scope, expires_at: isoSeconds(expires), status: 'active' },
      };
    },
  });

  defineRoute(app, deps, {
    op: 'API-052',
    params: z.object({ grantId: uuid }),
    body: emptyBody,
    permission: 'support.grant',
    permissionMessage: 'Only owners can manage support access.',
    handler: async ctx => {
      if (ctx.actor.support) throw new AppError('AUTHORIZATION_DENIED', 'Only owners can manage support access.');
      const g = await ctx.db.maybe<{ id: string; revoked_at: Date | null }>('SELECT id, revoked_at FROM lg.support_access_grants WHERE id = $1 FOR UPDATE', [ctx.params.grantId]);
      if (!g) throw new AppError('NOT_FOUND', 'Grant not found.');
      let revokedAt = g.revoked_at;
      if (!revokedAt) {
        revokedAt = ctx.now;
        await ctx.db.q('UPDATE lg.support_access_grants SET revoked_at = $2, revoked_by = $3 WHERE id = $1', [g.id, revokedAt, ctx.userId]);
        await ctx.audit('support.access_revoked', 'support_grant', g.id);
        await emit(ctx.db, ctx.orgId, 'support.access_revoked', { grant_id: g.id });
      }
      return { message: 'Support access revoked.', data: { grant_id: g.id, status: 'revoked', revoked_at: isoSeconds(revokedAt) } };
    },
  });
}
