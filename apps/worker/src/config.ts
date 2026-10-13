// Worker configuration (Section 35). The worker connects as lg_app (per-org work) and lg_scanner (sweeper).
export interface WorkerConfig {
  nodeEnv: string;
  databaseUrl: string;
  scannerDatabaseUrl: string;
  redisUrl: string | null;
  appUrl: string;
  emailProvider: string;
  emailFrom: string;
  smsAlerts: boolean;
  exportStorage: { dir: string; signingSecret: string; publicBaseUrl: string };
  sweepIntervalMs: number;
  publishIntervalMs: number;
  logLevel: string;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required (lg_app)');
  if (!env.SCANNER_DATABASE_URL) throw new Error('SCANNER_DATABASE_URL is required (lg_scanner)');
  const cursorSecret = env.CURSOR_SECRET ?? (nodeEnv === 'production' ? '' : 'dev-cursor-secret');
  const signing = env.EXPORT_SIGNING_SECRET ?? cursorSecret;
  if (!signing) throw new Error('EXPORT_SIGNING_SECRET (or CURSOR_SECRET) is required in production');
  return {
    nodeEnv,
    databaseUrl: env.DATABASE_URL,
    scannerDatabaseUrl: env.SCANNER_DATABASE_URL,
    redisUrl: env.REDIS_URL ?? null,
    appUrl: env.APP_URL ?? 'http://localhost:3000',
    emailProvider: env.EMAIL_PROVIDER ?? 'none',
    emailFrom: env.EMAIL_FROM ?? 'LeadGuard <alerts@leadguard.io>',
    smsAlerts: /sms_alerts:true/.test(env.FEATURE_FLAGS ?? ''),
    exportStorage: {
      dir: env.EXPORT_LOCAL_DIR ?? './.data/exports',
      signingSecret: signing,
      publicBaseUrl: env.EXPORT_PUBLIC_BASE_URL ?? env.API_URL ?? 'http://localhost:3001',
    },
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 30_000),
    publishIntervalMs: Number(env.PUBLISH_INTERVAL_MS ?? 1_000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
