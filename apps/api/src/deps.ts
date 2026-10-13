// Process-wide dependencies, built once at startup and passed to every module.
import { createPool, type Pool } from '@leadguard/db';
import {
  createBillingAdapter, createBotChallenge, createEmailAdapter, createLocalStorage,
  type BillingAdapter, type BotChallengeAdapter, type EmailAdapter, type ObjectStorage,
} from '@leadguard/adapters';
import type { Config } from './config.ts';
import { createRedis, type Redis } from './lib/redis.ts';
import { createRateLimiter, type RateLimiter } from './lib/rate-limit.ts';
import { createCursorCodec, type CursorCodec } from './lib/cursor.ts';

export interface Deps {
  config: Config;
  pool: Pool;
  redis: Redis | null;
  limiter: RateLimiter;
  cursors: CursorCodec;
  email: EmailAdapter;
  billing: BillingAdapter;
  botChallenge: BotChallengeAdapter;
  storage: ObjectStorage;
  close(): Promise<void>;
}

export function buildDeps(config: Config, overrides: Partial<Deps> = {}): Deps {
  const pool = overrides.pool ?? createPool(config.databaseUrl, { max: 20, applicationName: 'leadguard-api' });
  const redis = overrides.redis !== undefined ? overrides.redis : createRedis(config.redisUrl);
  const deps: Deps = {
    config,
    pool,
    redis,
    limiter: overrides.limiter ?? createRateLimiter(redis),
    cursors: overrides.cursors ?? createCursorCodec(config.cursorSecret),
    email: overrides.email ?? createEmailAdapter(config.emailProvider),
    billing: overrides.billing ?? createBillingAdapter(config.billingProvider),
    botChallenge: overrides.botChallenge ?? createBotChallenge(config.botChallengeProvider),
    storage: overrides.storage ?? createLocalStorage(config.exportStorage),
    async close() {
      await redis?.close();
      await pool.end();
    },
  };
  return deps;
}
