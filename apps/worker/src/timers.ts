// Timer claims as lg_scanner (DB-09, DB-10) and firing as lg_app (Section 12.1).
import { fireTimer, withOrg, wrap, type ClaimedTimer } from '@leadguard/db';
import type { WorkerContext } from './context.ts';
import { log, errFields } from './log.ts';

const BATCH = 100;

/** Return claims whose claimed_until passed without being fired to pending. */
export async function releaseExpiredClaims(ctx: WorkerContext): Promise<number> {
  const r = await ctx.scanner.query(
    `UPDATE lg.lead_timers SET state = 'pending', claimed_until = NULL WHERE state = 'claimed' AND claimed_until < now() RETURNING id`);
  return r.rowCount ?? 0;
}

/** Claim up to 100 due timers across all orgs with FOR UPDATE SKIP LOCKED. */
export async function claimDueTimers(ctx: WorkerContext, onlyId?: string): Promise<ClaimedTimer[]> {
  const client = await ctx.scanner.connect();
  try {
    const db = wrap(client);
    await db.q('BEGIN');
    const rows = await db.q<ClaimedTimer>(
      `UPDATE lg.lead_timers SET state = 'claimed', claimed_until = now() + interval '2 minutes'
        WHERE id IN (SELECT id FROM lg.lead_timers
                      WHERE state = 'pending' AND due_at <= now() ${onlyId ? 'AND id = $2' : ''}
                      ORDER BY due_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, org_id, claimed_until`, onlyId ? [BATCH, onlyId] : [BATCH]);
    await db.q('COMMIT');
    return rows;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function fireClaimed(ctx: WorkerContext, timers: ClaimedTimer[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of timers) ctx.inFlightTimers.add(t.id);
  for (const t of timers) {
    try {
      const outcome = await fireTimer(ctx.app, t, { emailConfigured: ctx.email.configured, smsConfigured: false });
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      if (outcome === 'fired') {
        // timer_fire_delay metric: due_at -> fired (Section 34.1).
        const d = await withOrg(ctx.app, t.org_id, null, db => db.maybe<{ delay: number }>(
          `SELECT extract(epoch FROM now() - due_at)::int AS delay FROM lg.lead_timers WHERE id = $1`, [t.id]));
        log.info('timer fired', { timer_id: t.id, org_id: t.org_id, timer_fire_delay_seconds: d?.delay });
      }
    } catch (e) {
      counts.error = (counts.error ?? 0) + 1;
      // The claim expires after 2 minutes and the timer is re-claimed (crash-before-commit window, Section 12.3).
      log.error('timer processing failed', { timer_id: t.id, org_id: t.org_id, ...errFields(e) });
    } finally {
      ctx.inFlightTimers.delete(t.id);
    }
  }
  return counts;
}

/** Wake-up job for one timer (lead-timers queue). The sweeper is the fallback. */
export async function wakeTimer(ctx: WorkerContext, timerId: string): Promise<void> {
  const claimed = await claimDueTimers(ctx, timerId);
  if (claimed.length) await fireClaimed(ctx, claimed);
}

/** Graceful shutdown: release this process's claims so another worker picks them up immediately. */
export async function releaseOwnClaims(ctx: WorkerContext): Promise<void> {
  if (!ctx.inFlightTimers.size) return;
  await ctx.scanner.query(`UPDATE lg.lead_timers SET state = 'pending', claimed_until = NULL WHERE state = 'claimed' AND id = ANY($1::uuid[])`, [[...ctx.inFlightTimers]]);
}
