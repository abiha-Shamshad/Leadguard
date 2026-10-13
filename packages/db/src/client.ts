// Connection pools and the org-context transaction helper (Sections 7.3, 15.1, 16).
import pg from 'pg';

// Return timestamptz as Date, bigint counts as number (counts here never exceed 2^53).
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

export type Pool = pg.Pool;

export interface Db {
  /** Run a query and return all rows. */
  q<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Exactly one row or throws. */
  one<T = any>(sql: string, params?: unknown[]): Promise<T>;
  /** Zero or one row. */
  maybe<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Number of affected rows. */
  exec(sql: string, params?: unknown[]): Promise<number>;
  readonly client: pg.PoolClient;
}

export function wrap(client: pg.PoolClient): Db {
  return {
    client,
    async q(sql, params) { return (await client.query(sql, params as any[])).rows; },
    async one(sql, params) {
      const r = await client.query(sql, params as any[]);
      if (r.rows.length !== 1) throw new Error(`expected one row, got ${r.rows.length}`);
      return r.rows[0];
    },
    async maybe(sql, params) { return (await client.query(sql, params as any[])).rows[0] ?? null; },
    async exec(sql, params) { return (await client.query(sql, params as any[])).rowCount ?? 0; },
  };
}

export function createPool(connectionString: string, opts: { max?: number; applicationName?: string } = {}): Pool {
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'leadguard',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * Run `fn` in one transaction with org and user context set via set_config(..., true).
 * `SET LOCAL ... = $1` cannot take a bind parameter (DB-01); set_config is transaction-local and never leaks (DB-05).
 */
export async function withOrg<T>(pool: Pool, orgId: string | null, userId: string | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [orgId ?? '', userId ?? '']);
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Switch org context inside an existing transaction (used by bootstrap flows that create the org). */
export async function setContext(db: Db, orgId: string | null, userId: string | null): Promise<void> {
  await db.q("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [orgId ?? '', userId ?? '']);
}

/** Pre-context access: only the SECURITY DEFINER lookups in Section 15.2 may be called this way. */
export async function withoutOrg<T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  return withOrg(pool, null, null, fn);
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === '23505' && (!constraint || err.constraint === constraint);
}
