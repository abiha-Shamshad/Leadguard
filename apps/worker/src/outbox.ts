// Outbox publisher (lg_scanner): enqueue BullMQ wake-ups after commit, then mark published (Section 17).
// Job IDs are row UUIDs; BullMQ rejects custom IDs containing ':' (EV-004).
import { wrap } from '@leadguard/db';
import type { WorkerContext } from './context.ts';
import { log, errFields } from './log.ts';

interface OutboxRow { id: string; org_id: string; routing_key: string; payload: Record<string, any>; created_at: Date }

export async function publishOutbox(ctx: WorkerContext, limit = 100): Promise<number> {
  const client = await ctx.scanner.connect();
  let published = 0;
  try {
    const db = wrap(client);
    await db.q('BEGIN');
    const rows = await db.q<OutboxRow>(
      `SELECT id, org_id, routing_key, payload, created_at FROM lg.outbox_events
        WHERE published_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    const done: string[] = [];
    for (const r of rows) {
      try {
        await route(ctx, r);
        done.push(r.id);
      } catch (e) {
        // Left unpublished; retried on the next pass (alert on outbox_unpublished_age_seconds > 60).
        log.warn('outbox publish failed', { event_id: r.id, routing_key: r.routing_key, ...errFields(e) });
      }
    }
    if (done.length) published = (await db.one<{ n: number }>('SELECT lg.mark_outbox_published($1::uuid[]) AS n', [done])).n;
    await db.q('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return published;
}

async function route(ctx: WorkerContext, r: OutboxRow): Promise<void> {
  const p = r.payload;
  switch (r.routing_key) {
    case 'timer.scheduled': {
      const due = Date.parse(p.due_at);
      const delayMs = Math.max(0, due - Date.now());
      await ctx.dispatcher.dispatch('lead-timers', `${p.timer_id}-${Math.floor(due / 1000)}`, { timer_id: p.timer_id, org_id: r.org_id }, { delayMs });
      return;
    }
    case 'alert.requested':
      await ctx.dispatcher.dispatch('alert-deliveries', p.delivery_id, { delivery_id: p.delivery_id, org_id: r.org_id });
      return;
    case 'export.requested':
      await ctx.dispatcher.dispatch('export-builds', p.export_id, { export_id: p.export_id, org_id: r.org_id });
      return;
    case 'org.recompute_due':
      await ctx.dispatcher.dispatch('due-recompute', r.id, { org_id: r.org_id });
      return;
    default:
      // Domain events with no Release 1 consumer (Section 31: consumers are internal workers only).
      return;
  }
}
