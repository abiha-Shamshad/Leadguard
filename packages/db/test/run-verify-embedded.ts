// Runs the delivered verify_db.mjs (19 checks) against a disposable embedded PostgreSQL with all migrations.
// Usage: tsx packages/db/test/run-verify-embedded.ts   (or set TEST_ADMIN_DATABASE_URL to use your own server)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { migrate, setRolePasswords } from '../src/migrate.ts';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../../apps/api/package.json'));
const { default: EmbeddedPostgres } = await import(pathToFileURL(require.resolve('embedded-postgres')).href);
const dir = mkdtempSync(join(tmpdir(), 'lgverify-'));
const port = 25000 + Math.floor(Math.random() * 10000);
const pw = 'verify-only';
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: pw, port, persistent: true, onLog: () => {}, onError: () => {} });
let code = 1;
try {
  await server.initialise();
  await server.start();
  await server.createDatabase('lgverify');
  const admin = `postgres://postgres:${pw}@127.0.0.1:${port}/lgverify`;
  console.log('migrations:', (await migrate(admin, () => {})).join(', '));
  await setRolePasswords(admin, { lg_app: pw, lg_scanner: pw });
  const verify = join(dirname(fileURLToPath(import.meta.url)), 'verify_db.mjs');
  const r = spawnSync(process.execPath, [verify], {
    stdio: 'inherit',
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGDATABASE: 'lgverify', PGPASSWORD: pw },
  });
  code = r.status ?? 1;
} finally {
  await server.stop();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may hold the data dir briefly */ }
}
process.exit(code);
