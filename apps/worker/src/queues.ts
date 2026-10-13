// BullMQ queues and workers (Section 17). Queue payloads carry IDs only; processors reload PostgreSQL rows.
import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { RetryableDeliveryError } from '@leadguard/db';
import type { Dispatcher, QueueName, WorkerContext } from './context.ts';
import { wakeTimer } from './timers.ts';
import { processBillingReconcile, processDelivery, processRecompute, processSourceHealth } from './processors.ts';
import { processExport } from './exports.ts';
import { log, errFields } from './log.ts';

export const QUEUES: QueueName[] = ['lead-timers', 'alert-deliveries', 'export-builds', 'source-health', 'billing-reconcile', 'due-recompute'];

const RETRY: Partial<Record<QueueName, { attempts: number; backoff: { type: 'exponential'; delay: number; jitter: number } }>> = {
  // 3 attempts for retryable provider errors, exponential 30 s base with jitter.
  'alert-deliveries': { attempts: 3, backoff: { type: 'exponential', delay: 30_000, jitter: 0.5 } },
  'export-builds': { attempts: 2, backoff: { type: 'exponential', delay: 30_000, jitter: 0.5 } },
};

export async function runJob(ctx: WorkerContext, queue: QueueName, data: Record<string, any>): Promise<unknown> {
  switch (queue) {
    case 'lead-timers': return wakeTimer(ctx, data.timer_id);
    case 'alert-deliveries': return processDelivery(ctx, data.org_id, data.delivery_id);
    case 'export-builds': return processExport(ctx, data.org_id, data.export_id);
    case 'source-health': return processSourceHealth(ctx, data.org_id, data.source_id);
    case 'billing-reconcile': return processBillingReconcile(ctx, data.org_id);
    case 'due-recompute': return processRecompute(ctx, data.org_id);
  }
}

export interface QueueSystem {
  dispatcher: Dispatcher;
  start(ctx: WorkerContext): void;
  close(): Promise<void>;
}

/** Inline dispatcher: used when REDIS_URL is not configured, and as the fallback while Redis is down. */
export function inlineDispatcher(getCtx: () => WorkerContext): Dispatcher {
  return {
    available: () => false,
    async dispatch(queue, _jobId, payload, opts) {
      if (opts?.delayMs && opts.delayMs > 0) return; // the sweeper fires it when due
      try {
        await runJob(getCtx(), queue, payload);
      } catch (e) {
        if (!(e instanceof RetryableDeliveryError)) log.warn('inline job failed', { queue, ...errFields(e) });
      }
    },
  };
}

export function createQueueSystem(redisUrl: string, getCtx: () => WorkerContext): QueueSystem {
  const url = new URL(redisUrl);
  const connection: ConnectionOptions = {
    host: url.hostname, port: Number(url.port || 6379), username: url.username || undefined, password: url.password || undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined, maxRetriesPerRequest: null, enableOfflineQueue: false,
  } as ConnectionOptions;
  const queues = new Map<QueueName, Queue>(QUEUES.map(q => [q, new Queue(q, { connection })]));
  const workers: Worker[] = [];
  let healthy = false;
  const inline = inlineDispatcher(getCtx);
  for (const q of queues.values()) {
    q.on('error', () => { healthy = false; });
  }
  // Dedicated connection for the health probe so a Redis outage is noticed and jobs run inline meanwhile.
  const probeClient = new IORedis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000 });
  probeClient.on('error', () => { healthy = false; });
  const probe = async () => {
    try { healthy = (await probeClient.ping()) === 'PONG'; } catch { healthy = false; }
  };
  const probeTimer = setInterval(() => void probe(), 5_000);
  void probe();

  const dispatcher: Dispatcher = {
    available: () => healthy,
    async dispatch(queue, jobId, payload, opts) {
      if (!healthy) return inline.dispatch(queue, jobId, payload, opts);
      try {
        await queues.get(queue)!.add(queue, payload, {
          jobId, delay: opts?.delayMs, removeOnComplete: true, removeOnFail: 1000, ...(RETRY[queue] ?? { attempts: 1 }),
        });
      } catch (e) {
        healthy = false;
        log.warn('enqueue failed; running inline', { queue, ...errFields(e) });
        await inline.dispatch(queue, jobId, payload, opts);
      }
    },
  };

  return {
    dispatcher,
    start(ctx) {
      for (const q of QUEUES) {
        const w = new Worker(q, async (job: Job) => runJob(ctx, q, job.data), {
          connection, concurrency: q === 'export-builds' ? 1 : 5,
        });
        w.on('failed', (job, err) => {
          const level = err instanceof RetryableDeliveryError ? 'info' : 'warn';
          log[level]('job failed', { queue: q, job_id: job?.id, attempts: job?.attemptsMade, error: err.message });
        });
        w.on('error', () => { healthy = false; });
        workers.push(w);
      }
    },
    async close() {
      clearInterval(probeTimer);
      probeClient.disconnect();
      await Promise.allSettled(workers.map(w => w.close()));
      await Promise.allSettled([...queues.values()].map(q => q.close()));
    },
  };
}
