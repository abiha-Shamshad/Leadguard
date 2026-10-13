// API-048 / API-049 Full CSV export (every subscription state). Files expire after 24 h; signed URLs after 15 min.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, errorEnvelope, exportBody, isoOrNull, isoSeconds, uuid } from '@leadguard/contracts';
import { uuidv7 } from '@leadguard/domain';
import { emit, isUniqueViolation } from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';

const MAX_EXPORTS_PER_DAY = 5;
const URL_MINUTES = 15;

export function registerExports(app: FastifyInstance, deps: Deps): void {
  // API-048 Request data export.
  defineRoute(app, deps, {
    op: 'API-048',
    body: exportBody,
    permission: 'exports.create',
    permissionMessage: 'Only owners can export data.',
    handler: async ctx => {
      const running = await ctx.db.maybe<{ id: string }>(`SELECT id FROM lg.exports WHERE status IN ('queued','building')`);
      if (running) throw new AppError('EXPORT_IN_PROGRESS', 'An export is already running.', { export_id: running.id });
      const today = await ctx.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM lg.exports WHERE created_at > now() - interval '24 hours'`);
      if (today.n >= MAX_EXPORTS_PER_DAY) {
        throw new AppError('RATE_LIMITED', `You can request at most ${MAX_EXPORTS_PER_DAY} exports per day.`, {}, { headers: { 'Retry-After': '3600' } });
      }
      const id = uuidv7();
      try {
        await ctx.db.q('INSERT INTO lg.exports (id, org_id, requested_by, include) VALUES ($1,$2,$3,$4)', [id, ctx.orgId, ctx.userId, ctx.body.include]);
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError('EXPORT_IN_PROGRESS', 'An export is already running.');
        throw e;
      }
      await ctx.audit('export.requested', 'export', id);
      await emit(ctx.db, ctx.orgId, 'export.requested', { export_id: id });
      return {
        status: 202,
        message: deps.email.configured ? 'Export started. We will email you when it is ready.' : 'Export started. Check back here in a few minutes.',
        data: { export_id: id, status: 'queued', poll_url: `/api/v1/exports/${id}` },
      };
    },
  });

  // API-049 Export status and download (short-lived signed URL; issuing it is audited).
  defineRoute(app, deps, {
    op: 'API-049',
    params: z.object({ exportId: uuid }),
    permission: 'exports.create',
    permissionMessage: 'Only owners can export data.',
    handler: async ctx => {
      const e = await ctx.db.maybe<{ id: string; status: string; rows: any; file_key: string | null; expires_at: Date | null; failure_reason: string | null; created_at: Date }>(
        'SELECT id, status, rows, file_key, expires_at, failure_reason, created_at FROM lg.exports WHERE id = $1', [ctx.params.exportId]);
      if (!e || e.status === 'expired' || (e.status === 'ready' && e.expires_at && e.expires_at <= ctx.now)) throw new AppError('NOT_FOUND', 'Export not found or expired.');
      const data: Record<string, unknown> = { export_id: e.id, status: e.status, requested_at: isoSeconds(e.created_at) };
      if (e.status === 'failed') data.failure_reason = e.failure_reason;
      if (e.status === 'ready' && e.file_key) {
        const urlExpires = new Date(Math.min(ctx.now.getTime() + URL_MINUTES * 60_000, e.expires_at!.getTime()));
        data.rows = e.rows;
        data.download_url = deps.storage.signedUrl(e.file_key, urlExpires);
        data.url_expires_at = isoSeconds(urlExpires);
        data.file_expires_at = isoOrNull(e.expires_at);
        await ctx.audit('export.downloaded', 'export', e.id);
      }
      return { data };
    },
  });

  // Signed download for the `local` storage adapter (files host). Not an API operation; no auth beyond the signature.
  app.get('/files/*', async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    const { expires, sig } = req.query as { expires?: string; sig?: string };
    if (!expires || !sig || !deps.storage.verifySignature(key, expires, sig)) {
      return reply.code(404).send(errorEnvelope('NOT_FOUND', 'Export not found or expired.', req.requestId));
    }
    const file = await deps.storage.get(key);
    if (!file) return reply.code(404).send(errorEnvelope('NOT_FOUND', 'Export not found or expired.', req.requestId));
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="leadguard-export.zip"`)
      .header('Cache-Control', 'no-store')
      .send(file);
  });
}
