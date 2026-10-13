// Local development stack without Docker: embedded PostgreSQL (persistent in .data/pg) + migrations +
// API (port 3001) + worker, all with AUTH_MODE=dev. Then run `pnpm dev:web` and open http://localhost:3000.
// Usage: pnpm dev:stack        (Ctrl+C stops everything)
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { migrate, setRolePasswords } from '@leadguard/db';

const root = process.cwd();
const req = createRequire(join(root, 'apps/api/package.json'));
const { default: EmbeddedPostgres } = await import(pathToFileURL(req.resolve('embedded-postgres')).href);

const dataDir = join(root, '.data', 'pg');
const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.DEV_PG_PORT ?? 54329);
const pw = 'dev-only';
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: pw, port, persistent: true, onLog: () => {}, onError: () => {} });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('leadguard');
const admin = `postgres://postgres:${pw}@127.0.0.1:${port}/leadguard`;
const applied = await migrate(admin, () => {});
await setRolePasswords(admin, { lg_app: pw, lg_scanner: pw });
console.log(`[dev-stack] PostgreSQL on ${port}${applied.length ? `, applied ${applied.join(', ')}` : ', schema up to date'}`);

const env = {
  ...process.env,
  NODE_ENV: 'development',
  AUTH_MODE: 'dev',
  PORT: '3001',
  API_URL: 'http://localhost:3001',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: `postgres://lg_app:${pw}@127.0.0.1:${port}/leadguard`,
  SCANNER_DATABASE_URL: `postgres://lg_scanner:${pw}@127.0.0.1:${port}/leadguard`,
  EXPORT_LOCAL_DIR: join(root, '.data', 'exports'),
  SWEEP_INTERVAL_MS: process.env.SWEEP_INTERVAL_MS ?? '30000',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
};
const children: ChildProcess[] = [
  spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], { env, stdio: 'inherit' }),
  spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], { env, stdio: 'inherit' }),
];
console.log('[dev-stack] API http://localhost:3001  (health: /internal/v1/health)  - start the web app with: pnpm dev:web');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  await pg.stop();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
