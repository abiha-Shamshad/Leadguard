// Worker service entry point (same codebase/image as the API). Graceful shutdown releases timer claims.
import { createPool } from '@leadguard/db';
import { createEmailAdapter, createLocalStorage } from '@leadguard/adapters';
import { loadWorkerConfig } from './config.ts';
import type { WorkerContext } from './context.ts';
import { createQueueSystem, inlineDispatcher, type QueueSystem } from './queues.ts';
import { sweep } from './sweeper.ts';
import { publishOutbox } from './outbox.ts';
import { releaseOwnClaims } from './timers.ts';
import { processBillingReconcile, processDailyMetrics } from './processors.ts';
import { log, errFields, setLogLevel } from './log.ts';

const config = loadWorkerConfig();
setLogLevel(config.logLevel);

let ctx!: WorkerContext;
const queueSystem: QueueSystem | null = config.redisUrl ? createQueueSystem(config.redisUrl, () => ctx) : null;
ctx = {
  config,
  app: createPool(config.databaseUrl, { max: 10, applicationName: 'leadguard-worker' }),
  scanner: createPool(config.scannerDatabaseUrl, { max: 3, applicationName: 'leadguard-sweeper' }),
  email: createEmailAdapter(config.emailProvider),
  storage: createLocalStorage(config.exportStorage),
  dispatcher: queueSystem?.dispatcher ?? inlineDispatcher(() => ctx),
  inFlightTimers: new Set(),
};
queueSystem?.start(ctx);
if (!ctx.email.configured) log.warn('EMAIL_PROVIDER=none: alerts are in-app only (INT-003 BLOCKED)');

let stopping = false;
const loops: NodeJS.Timeout[] = [];

function every(ms: number, name: string, fn: () => Promise<unknown>): void {
  let running = false;
  const tick = async () => {
    if (running || stopping) return;
    running = true;
    try {
      const r = await fn();
      if (r && typeof r === 'object' && Object.values(r as Record<string, number>).some(v => v)) log.info(name, r as Record<string, unknown>);
    } catch (e) {
      log.error(`${name} failed`, errFields(e));
    } finally {
      running = false;
    }
  };
  loops.push(setInterval(() => void tick(), ms));
  void tick();
}

async function forEachOrg(fn: (orgId: string) => Promise<void>): Promise<{ orgs: number; failed: number }> {
  const r = await ctx.scanner.query<{ org_id: string }>('SELECT org_id FROM lg.scan_orgs()');
  let failed = 0;
  for (const row of r.rows) {
    try { await fn(row.org_id); } catch (e) { failed++; log.warn('org job failed', { org_id: row.org_id, ...errFields(e) }); }
  }
  return { orgs: r.rows.length, failed };
}

every(config.publishIntervalMs, 'outbox', async () => ({ published: await publishOutbox(ctx) }));
every(config.sweepIntervalMs, 'sweep', () => sweep(ctx));
every(15 * 60_000, 'source-health', async () => {
  const r = await ctx.scanner.query<{ source_id: string; org_id: string }>('SELECT source_id, org_id FROM lg.scan_sources()');
  for (const s of r.rows) await ctx.dispatcher.dispatch('source-health', `${s.source_id}-${Math.floor(Date.now() / 900_000)}`, { source_id: s.source_id, org_id: s.org_id });
  return { sources: r.rows.length };
});
every(60 * 60_000, 'billing-reconcile', () => forEachOrg(orgId => processBillingReconcile(ctx, orgId)));
every(15 * 60_000, 'daily-metrics', () => forEachOrg(orgId => processDailyMetrics(ctx, orgId)));

log.info('worker started', { redis: Boolean(config.redisUrl), email_provider: ctx.email.name });

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('worker stopping', { signal });
  loops.forEach(clearInterval);
  const timer = setTimeout(() => process.exit(1), 30_000);
  try {
    await queueSystem?.close();
    await releaseOwnClaims(ctx);
    await ctx.app.end();
    await ctx.scanner.end();
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
