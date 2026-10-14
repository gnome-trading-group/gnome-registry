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

// What a live session needs before it may be created (launch-checks.ts): every required risk policy, here as global
// rows generous enough never to bind, and a recent balance on each active venue account with room for the budgets.
// Idempotent, so a test can call it before each live session it creates.
const GENEROUS = 1_000_000_000_000_000;

export async function allowLiveLaunches(client: PoolClient): Promise<void> {
  const required: [string, Record<string, number>][] = [
    ['MAX_COMMITTED_CAPITAL', { maxCapital: GENEROUS }],
    ['MAX_TOTAL_PNL_LOSS', { maxLoss: GENEROUS }],
    ['MAX_POSITION', { maxPosition: GENEROUS }],
    ['MAX_CONSECUTIVE_REJECTS', { maxRejects: 1000 }],
  ];
  for (const [type, parameters] of required) {
    await client.query(
      `INSERT INTO risk.policy (policy_type, parameters) SELECT $1::varchar, $2::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM risk.policy WHERE policy_type = $1::varchar AND strategy_id IS NULL
                         AND exchange_id IS NULL AND listing_id IS NULL AND session_id IS NULL)`,
      [type, JSON.stringify(parameters)]);
  }
  // A minute old, so a balance a test posts itself is always the latest.
  await client.query(
    `INSERT INTO treasury.balance_snapshot (account_id, taken_at, source, status, cash_total, cash_available)
     SELECT a.account_id, NOW() - INTERVAL '1 minute', 'MANUAL', 'OK', $1, $1
     FROM account_master.venue_account a
     WHERE a.status = 'ACTIVE' AND NOT EXISTS (
       SELECT 1 FROM treasury.balance_snapshot b WHERE b.account_id = a.account_id AND b.status = 'OK'
         AND b.taken_at > NOW() - INTERVAL '10 minutes')`,
    [String(GENEROUS)]);
}
