// Configuration and environment variables (Section 35). Secrets come from the cloud secret manager.
import { loadPlanConfig, type PlanConfig } from '@leadguard/contracts';

export interface FeatureFlags {
  call_sources: boolean;
  self_service_checkout: boolean;
  embed_sources: boolean;
  sms_alerts: boolean;
}

export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  appUrl: string;
  apiUrl: string;
  databaseUrl: string;
  redisUrl: string | null;
  authMode: 'clerk' | 'dev';
  clerk: { publishableKey?: string; secretKey?: string; jwtKey?: string };
  supportClerk: { publishableKey?: string; secretKey?: string };
  sourceSecretKeys: Buffer[];
  cursorSecret: string;
  emailProvider: string;
  emailFrom: string;
  botChallengeProvider: string;
  billingProvider: string;
  exportStorage: { kind: 'local'; dir: string; signingSecret: string; publicBaseUrl: string };
  flags: FeatureFlags;
  plans: PlanConfig;
  logLevel: string;
  /** Trusted reverse-proxy hops for X-Forwarded-For. 0 = trust nothing (client IPs cannot be spoofed). */
  trustProxyHops: number;
  rateLimits: { userPerMinute: number; ipUnauthPerMinute: number };
  version: string;
}

function parseFlags(raw: string | undefined): FeatureFlags {
  const flags: FeatureFlags = { call_sources: false, self_service_checkout: false, embed_sources: false, sms_alerts: false };
  for (const part of (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [k, v] = part.split(':');
    if (k in flags) (flags as any)[k] = v === 'true';
  }
  return flags;
}

function parseKeys(raw: string | undefined, nodeEnv: string): Buffer[] {
  if (!raw) {
    if (nodeEnv === 'production') throw new Error('SOURCE_SECRET_ENCRYPTION_KEYS is required in production');
    // Development-only fixed key so local secrets survive restarts. Never used in production.
    return [Buffer.alloc(32, 7)];
  }
  const keys = raw.split(',').map(k => Buffer.from(k.trim(), 'base64'));
  if (keys.some(k => k.length !== 32)) throw new Error('SOURCE_SECRET_ENCRYPTION_KEYS must be comma-separated base64 32-byte keys (newest first)');
  return keys;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const authMode = (env.AUTH_MODE ?? (nodeEnv === 'production' ? 'clerk' : 'dev')) as Config['authMode'];
  if (authMode === 'dev' && nodeEnv === 'production') throw new Error('AUTH_MODE=dev is not allowed in production');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (runtime connection as lg_app)');
  if (authMode === 'clerk' && (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY)) throw new Error('CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required');
  const apiUrl = env.API_URL ?? 'http://localhost:3001';
  const cursorSecret = env.CURSOR_SECRET ?? (nodeEnv === 'production' ? '' : 'dev-cursor-secret');
  if (!cursorSecret) throw new Error('CURSOR_SECRET is required in production');
  return {
    nodeEnv,
    port: Number(env.PORT ?? 3001),
    host: env.HOST ?? '0.0.0.0',
    appUrl: env.APP_URL ?? 'http://localhost:3000',
    apiUrl,
    databaseUrl,
    redisUrl: env.REDIS_URL ?? null,
    authMode,
    clerk: { publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY },
    supportClerk: { publishableKey: env.SUPPORT_CLERK_PUBLISHABLE_KEY, secretKey: env.SUPPORT_CLERK_SECRET_KEY },
    sourceSecretKeys: parseKeys(env.SOURCE_SECRET_ENCRYPTION_KEYS, nodeEnv),
    cursorSecret,
    emailProvider: env.EMAIL_PROVIDER ?? 'none',
    emailFrom: env.EMAIL_FROM ?? 'LeadGuard <alerts@leadguard.io>',
    botChallengeProvider: env.BOT_CHALLENGE_PROVIDER ?? 'none',
    billingProvider: env.BILLING_PROVIDER ?? 'none',
    exportStorage: {
      kind: 'local',
      dir: env.EXPORT_LOCAL_DIR ?? './.data/exports',
      signingSecret: env.EXPORT_SIGNING_SECRET ?? cursorSecret,
      publicBaseUrl: env.EXPORT_PUBLIC_BASE_URL ?? apiUrl,
    },
    flags: parseFlags(env.FEATURE_FLAGS),
    plans: loadPlanConfig(env),
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 0),
    rateLimits: { userPerMinute: Number(env.RATE_LIMIT_USER_PER_MINUTE ?? 600), ipUnauthPerMinute: Number(env.RATE_LIMIT_IP_UNAUTH_PER_MINUTE ?? 60) },
    version: '1.1.0',
  };
}
