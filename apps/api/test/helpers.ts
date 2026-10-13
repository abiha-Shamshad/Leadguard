// Test harness: a disposable PostgreSQL (embedded binary, or TEST_ADMIN_DATABASE_URL), migrations applied as
// admin, the API built with AUTH_MODE=dev and the runtime roles lg_app / lg_scanner - exactly as in production.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate, setRolePasswords, createPool, type Pool } from '@leadguard/db';
import { loadConfig } from '../src/config.ts';
import { buildDeps, type Deps } from '../src/deps.ts';
import { buildApp } from '../src/app.ts';
import type { FastifyInstance } from 'fastify';

export interface Harness {
  config: ReturnType<typeof loadConfig>;
  app: FastifyInstance;
  deps: Deps;
  admin: pg.Pool;
  appUrl: string;
  scannerUrl: string;
  scanner: Pool;
  exportDir: string;
  stop(): Promise<void>;
}

const ROLE_PW = 'test-only-pw';

async function startDatabase(): Promise<{ adminUrl: string; host: string; port: number; db: string; stop: () => Promise<void> }> {
  const dbName = `lg_test_${randomBytes(4).toString('hex')}`;
  if (process.env.TEST_ADMIN_DATABASE_URL) {
    const base = new URL(process.env.TEST_ADMIN_DATABASE_URL);
    const c = new pg.Client({ connectionString: base.toString() });
    await c.connect();
    await c.query(`CREATE DATABASE ${dbName}`);
    await c.end();
    const u = new URL(base.toString());
    u.pathname = `/${dbName}`;
    return { adminUrl: u.toString(), host: u.hostname, port: Number(u.port || 5432), db: dbName, stop: async () => {} };
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = mkdtempSync(join(tmpdir(), 'lgpg-'));
  const port = 15000 + Math.floor(Math.random() * 20000);
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  await server.createDatabase(dbName);
  return {
    adminUrl: `postgres://postgres:postgres@127.0.0.1:${port}/${dbName}`,
    host: '127.0.0.1', port, db: dbName,
    stop: async () => { await server.stop(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ } },
  };
}

export async function startHarness(env: Record<string, string> = {}, overrides: Partial<Deps> = {}, appOpts: { logStream?: NodeJS.WritableStream } = {}): Promise<Harness> {
  const db = await startDatabase();
  await migrate(db.adminUrl, () => {});
  await setRolePasswords(db.adminUrl, { lg_app: ROLE_PW, lg_scanner: ROLE_PW });
  const appUrl = `postgres://lg_app:${ROLE_PW}@${db.host}:${db.port}/${db.db}`;
  const scannerUrl = `postgres://lg_scanner:${ROLE_PW}@${db.host}:${db.port}/${db.db}`;
  const exportDir = mkdtempSync(join(tmpdir(), 'lgexp-'));
  const config = loadConfig({
    NODE_ENV: 'test', AUTH_MODE: 'dev', DATABASE_URL: appUrl, API_URL: 'http://api.test', APP_URL: 'http://app.test',
    CURSOR_SECRET: 'test-cursor', EXPORT_LOCAL_DIR: exportDir, LOG_LEVEL: 'silent', ...env,
  });
  const deps = buildDeps(config, { redis: null, ...overrides });
  const app = await buildApp(deps, appOpts);
  const admin = new pg.Pool({ connectionString: db.adminUrl, max: 2 });
  const scanner = createPool(scannerUrl, { max: 2 });
  return {
    config, app, deps, admin, appUrl, scannerUrl, scanner, exportDir,
    async stop() {
      await app.close();
      await deps.close();
      await scanner.end();
      await admin.end();
      await db.stop();
      rmSync(exportDir, { recursive: true, force: true });
    },
  };
}

export function bearer(clerkId: string, email: string, name: string): string {
  return `Bearer dev:${clerkId}:${email}:${name}`;
}

let n = 0;
export const idem = () => `test-key-${Date.now()}-${n++}`;
