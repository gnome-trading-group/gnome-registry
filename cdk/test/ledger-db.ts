import { Pool, PoolClient } from 'pg';

// The database suites share one test database and empty its tables before each test, so they take turns: each holds
// this lock for its whole run, while the rest of the tests still run in parallel.
const SUITE_LOCK = 4_242_001;
const LOCK_TIMEOUT_MS = 120_000;

export async function connectExclusive(url: string): Promise<{ pool: Pool; client: PoolClient }> {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [SUITE_LOCK]);
  return { pool, client };
}

export async function release(pool: Pool, client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [SUITE_LOCK]);
  client.release();
  await pool.end();
}

export { LOCK_TIMEOUT_MS };
