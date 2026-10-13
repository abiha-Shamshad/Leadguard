// Sweeper (every 30 s): claims due timers, releases expired claims, republishes the outbox and rebuilds lost
// wake-ups for deliveries and exports from PostgreSQL rows - so a Redis loss never loses work (Section 17).
import { markSendingUnknown, withOrg } from '@leadguard/db';
import type { WorkerContext } from './context.ts';
import { claimDueTimers, fireClaimed, releaseExpiredClaims } from './timers.ts';
import { publishOutbox } from './outbox.ts';
import { expireExport } from './exports.ts';
import { log, errFields } from './log.ts';

export async function sweep(ctx: WorkerContext): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};
  stats.claims_released = await releaseExpiredClaims(ctx);

  // Claim and fire in batches of 100 until nothing is due.
  for (let i = 0; i < 20; i++) {
    const claimed = await claimDueTimers(ctx);
    if (!claimed.length) break;
    const c = await fireClaimed(ctx, claimed);
    for (const [k, v] of Object.entries(c)) stats[`timers_${k}`] = (stats[`timers_${k}`] ?? 0) + v;
  }

  stats.outbox_published = await publishOutbox(ctx, 500);

  const stale = await ctx.scanner.query<{ kind: string; id: string; org_id: string }>('SELECT kind, id, org_id FROM lg.scan_stale_work()');
  for (const w of stale.rows) {
    try {
      switch (w.kind) {
        case 'delivery_pending':
          await ctx.dispatcher.dispatch('alert-deliveries', w.id, { delivery_id: w.id, org_id: w.org_id });
          break;
        case 'delivery_sending':
          // Provider may have accepted it: record `unknown`, never resend automatically (Section 12.3).
          await markSendingUnknown(ctx.app, w.org_id, w.id);
          break;
        case 'export_queued':
          await ctx.dispatcher.dispatch('export-builds', w.id, { export_id: w.id, org_id: w.org_id });
          break;
        case 'export_expired':
          await expireExport(ctx, w.org_id, w.id);
          break;
        case 'window_expired':
          await withOrg(ctx.app, w.org_id, null, db => db.q(`UPDATE lg.verification_windows SET result = 'expired' WHERE id = $1 AND result = 'open' AND expires_at < now()`, [w.id]));
          break;
      }
      stats[w.kind] = (stats[w.kind] ?? 0) + 1;
    } catch (e) {
      log.warn('stale work recovery failed', { kind: w.kind, id: w.id, org_id: w.org_id, ...errFields(e) });
    }
  }
  return stats;
}
