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

// Binds a live session to a venue account on an exchange, creating the account if it doesn't exist yet. Live
// sessions trade through an account, and the ledger refuses a live write without one.
export async function bindAccount(client: PoolClient, sessionId: string, exchangeId = 1, label = 'steady-heron-01'): Promise<number> {
  const account = await client.query(
    `INSERT INTO account_master.venue_account (exchange_id, label, status, trading_secret_name, activated_at)
     VALUES ($1, $2, 'ACTIVE', 'gnome/test', NOW())
     ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label RETURNING account_id`,
    [exchangeId, label]);
  const accountId = account.rows[0].account_id;
  await client.query(
    `INSERT INTO account_master.session_venue_account (session_id, exchange_id, account_id) VALUES ($1, $2, $3)`,
    [sessionId, exchangeId, accountId]);
  return accountId;
}
