// Smoke test of the built bundles: embedded PostgreSQL -> migrations -> dist/server.js + dist/main.js -> HTTP.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { migrate, setRolePasswords } from '@leadguard/db';

const root = process.cwd();
const req = createRequire(join(root, 'apps/api/package.json'));
const { default: EmbeddedPostgres } = await import(pathToFileURL(req.resolve('embedded-postgres')).href);
const port = 26000 + Math.floor(Math.random() * 5000);
const pg = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'lgsmoke-')), user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {}, onError: () => {} });
await pg.initialise(); await pg.start(); await pg.createDatabase('smoke');
await migrate(`postgres://postgres:pw@127.0.0.1:${port}/smoke`, () => {});
await setRolePasswords(`postgres://postgres:pw@127.0.0.1:${port}/smoke`, { lg_app: 'pw', lg_scanner: 'pw' });
const env = { ...process.env, NODE_ENV: 'development', AUTH_MODE: 'dev', PORT: '3999', DATABASE_URL: `postgres://lg_app:pw@127.0.0.1:${port}/smoke`,
  SCANNER_DATABASE_URL: `postgres://lg_scanner:pw@127.0.0.1:${port}/smoke`, LOG_LEVEL: 'warn', SWEEP_INTERVAL_MS: '2000' };
const api = spawn(process.execPath, ['apps/api/dist/server.js'], { env, stdio: 'inherit' });
const worker = spawn(process.execPath, ['apps/worker/dist/main.js'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
const H = { authorization: 'Bearer dev:smoke_user:owner@smoke.example:Smoke Owner', 'content-type': 'application/json' };
let ok = false;
for (let i = 0; i < 40 && !ok; i++) { await new Promise(r => setTimeout(r, 250)); try { ok = (await fetch('http://127.0.0.1:3999/internal/v1/health')).ok; } catch {} }
const health: any = await (await fetch('http://127.0.0.1:3999/internal/v1/health')).json();
const org = await fetch('http://127.0.0.1:3999/api/v1/organizations', { method: 'POST', headers: { ...H, 'idempotency-key': 'smoke-org-0001' }, body: JSON.stringify({ name: 'Smoke Co', time_zone: 'America/Chicago' }) });
const me: any = await (await fetch('http://127.0.0.1:3999/api/v1/me', { headers: H })).json();
await new Promise(r => setTimeout(r, 3000));
const lag: any = await (await fetch('http://127.0.0.1:3999/internal/v1/health')).json();
console.log(JSON.stringify({ health: health.status, create_org: org.status, me_role: me.data.active_org?.role, outbox_lag_after_worker: lag.checks.outbox_lag_seconds }));
api.kill(); worker.kill();
await pg.stop();
process.exit(0);
