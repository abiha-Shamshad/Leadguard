// Applies packages/db/migrations/*.sql in order as an admin role (TASK-002).
// CLI: MIGRATION_ADMIN_DATABASE_URL=postgres://postgres@host/db tsx packages/db/src/migrate-cli.ts
// The admin connection is used only here (CI deploy step); running containers use lg_app / lg_scanner.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(adminUrl: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.leadguard_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM public.leadguard_migrations')).rows.map(r => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      log(`applying ${f}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('RESET ROLE');
        await client.query('INSERT INTO public.leadguard_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${f}: ${(e as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

/** Set login passwords for the runtime roles outside the migration (TASK-002 step 2). */
export async function setRolePasswords(adminUrl: string, passwords: Partial<Record<'lg_owner' | 'lg_app' | 'lg_scanner', string>>): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [role, pw] of Object.entries(passwords)) {
      if (!pw) continue;
      const lit = (await client.query('SELECT quote_literal($1) AS l', [pw])).rows[0].l;
      await client.query(`ALTER ROLE ${role} PASSWORD ${lit}`);
    }
  } finally {
    await client.end();
  }
}
