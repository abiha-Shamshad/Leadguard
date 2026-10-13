// Worker dependencies shared by every processor.
import type { Pool } from '@leadguard/db';
import type { EmailAdapter, ObjectStorage } from '@leadguard/adapters';
import type { WorkerConfig } from './config.ts';

export type QueueName = 'lead-timers' | 'alert-deliveries' | 'export-builds' | 'source-health' | 'billing-reconcile' | 'due-recompute';

export interface Dispatcher {
  /**
   * Enqueue a wake-up job. When Redis is unavailable the job runs inline, because PostgreSQL rows are
   * authoritative and the queue is only a wake-up (Section 17).
   */
  dispatch(queue: QueueName, jobId: string, payload: Record<string, unknown>, opts?: { delayMs?: number }): Promise<void>;
  available(): boolean;
}

export interface WorkerContext {
  config: WorkerConfig;
  /** lg_app: per-organization work with org context from the durable row. */
  app: Pool;
  /** lg_scanner: timer claims and outbox publishing only. */
  scanner: Pool;
  email: EmailAdapter;
  storage: ObjectStorage;
  dispatcher: Dispatcher;
  /** Timers currently claimed by this process (released on graceful shutdown). */
  inFlightTimers: Set<string>;
}
