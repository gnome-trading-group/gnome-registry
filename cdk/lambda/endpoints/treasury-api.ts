import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { getActor, withTransaction } from './base';
import { connectLedgerDatabase, createResponse, isPositiveInt } from './ledger-common';
import { PollerMarksError, recordPollerMarks } from './ledger-poller-marks';
import { accountTreasury, parseSnapshot, recordSnapshot, TreasuryError } from './treasury';

// The treasury's routes. The venue poller posts snapshots and reads which accounts to poll with the API key; an
// operator's manual snapshot, transfers and account settings are Cognito only, so each is attributed to a person. The
// mark poller's route (ledger-poller-marks.ts) is served here too.

const TRANSFER_KINDS = ['OPENING', 'DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'REWARD', 'FEE_ADJUSTMENT', 'CORRECTION'];
const CONFIG_MONEY = ['minBuffer', 'lowBalanceThreshold', 'cashTolerance', 'dustThreshold'] as const;
const CONFIG_COLUMNS: Record<string, string> = {
  minBuffer: 'min_buffer', lowBalanceThreshold: 'low_balance_threshold', cashTolerance: 'cash_tolerance',
  dustThreshold: 'dust_threshold', maxActiveDays: 'max_active_days', reconSince: 'recon_since',
  reconEnabled: 'recon_enabled', snapshotMaxAgeMinutes: 'snapshot_max_age', settlementGraceMinutes: 'settlement_grace',
};

function strings(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object' || value instanceof Date || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strings(v)]));
}

// Accounts the poller reads: everything it needs to find each one on its venue, and never a trading secret.
export async function pollTargets(client: PoolClient) {
  return (await client.query(
    `SELECT a.account_id, a.exchange_id, e.exchange_code, a.label, a.venue_ref, a.read_secret_name
     FROM account_master.venue_account a JOIN sm.exchange e USING (exchange_id)
     WHERE a.status IN ('PROVISIONING', 'ACTIVE', 'DRAINING') ORDER BY a.account_id`)).rows;
}

export async function summary(client: PoolClient, now: Date) {
  const accounts = await accountTreasury(client, null, now);
  const recon = (await client.query(
    `SELECT DISTINCT ON (account_id) account_id, cash_status, cash_diff, expected_cash, venue_cash, ran_at,
       positions_checked, position_breaks
     FROM treasury.recon_run ORDER BY account_id, ran_at DESC, run_id DESC`)).rows;
  return {
    asOf: now.toISOString(),
    accounts: accounts.map(a => {
      const r = recon.find(x => x.account_id === a.accountId);
      return {
        ...(strings(a) as Record<string, unknown>),
        recon: r ? {
          cashStatus: r.cash_status, cashDiff: r.cash_diff, expectedCash: r.expected_cash, venueCash: r.venue_cash,
          ranAt: r.ran_at, positionsChecked: r.positions_checked, positionBreaks: r.position_breaks,
        } : null,
      };
    }),
  };
}

export async function recordTransfer(client: PoolClient, body: string, actor: string) {
  const t = JSON.parse(body) as {
    accountId?: number; kind?: string; amount?: string | number; occurredAt?: string; externalRef?: string; reason?: string;
  };
  if (!isPositiveInt(t.accountId)) throw new TreasuryError(400, 'accountId must be a positive integer');
  if (typeof t.kind !== 'string' || !TRANSFER_KINDS.includes(t.kind)) {
    throw new TreasuryError(400, `kind must be one of ${TRANSFER_KINDS.join(', ')}`);
  }
  if (t.amount === undefined || !/^-?\d+$/.test(String(t.amount))) {
    throw new TreasuryError(400, 'amount must be an integer in price units (1e9 per dollar)');
  }
  const occurredAt = t.occurredAt ? new Date(t.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new TreasuryError(400, 'occurredAt must be a timestamp');
  if (typeof t.reason !== 'string' || t.reason.trim().length === 0) throw new TreasuryError(400, 'reason is required');
  try {
    const row = (await client.query(
      `INSERT INTO treasury.transfer (account_id, kind, amount, occurred_at, external_ref, reason, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [t.accountId, t.kind, String(t.amount), occurredAt, t.externalRef ?? null, t.reason, actor])).rows[0];
    // An account's first OPENING is where its reconciliation starts.
    if (t.kind === 'OPENING') {
      await client.query(
        `UPDATE treasury.account_config SET recon_since = $2, actor = $3, updated_at = NOW()
         WHERE account_id = $1 AND recon_since IS NULL`, [t.accountId, occurredAt, actor]);
    }
    return row;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === '23514') throw new TreasuryError(400, `a ${t.kind} amount has the wrong sign`);
    if (code === '23503') throw new TreasuryError(400, `Unknown account ${t.accountId}`);
    throw error;
  }
}

export async function updateConfig(client: PoolClient, body: string, actor: string) {
  const c = JSON.parse(body) as Record<string, unknown>;
  if (!isPositiveInt(c.accountId)) throw new TreasuryError(400, 'accountId must be a positive integer');
  const sets: string[] = [];
  const values: unknown[] = [c.accountId];
  for (const [key, column] of Object.entries(CONFIG_COLUMNS)) {
    if (c[key] === undefined) continue;
    let value: unknown = c[key];
    if ((CONFIG_MONEY as readonly string[]).includes(key) && !/^\d+$/.test(String(value))) {
      throw new TreasuryError(400, `${key} must be a non-negative integer in price units`);
    }
    if (key === 'snapshotMaxAgeMinutes' || key === 'settlementGraceMinutes') {
      if (!isPositiveInt(value)) throw new TreasuryError(400, `${key} must be a positive number of minutes`);
      value = `${value} minutes`;
    }
    if (key === 'maxActiveDays' && value !== null && !isPositiveInt(value)) {
      throw new TreasuryError(400, 'maxActiveDays must be a positive integer or null');
    }
    if (key === 'reconEnabled' && typeof value !== 'boolean') throw new TreasuryError(400, 'reconEnabled must be true or false');
    if (key === 'reconSince' && value !== null && Number.isNaN(new Date(String(value)).getTime())) {
      throw new TreasuryError(400, 'reconSince must be a timestamp or null');
    }
    values.push(typeof value === 'number' || typeof value === 'bigint' ? String(value) : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (c.partitionLowThresholds !== undefined) {
    const thresholds = c.partitionLowThresholds;
    if (thresholds === null || typeof thresholds !== 'object' || Array.isArray(thresholds)
      || Object.entries(thresholds).some(([k, v]) => !/^\d+$/.test(k) || !/^\d+$/.test(String(v)))) {
      throw new TreasuryError(400, 'partitionLowThresholds maps partition numbers to non-negative price-unit amounts');
    }
    values.push(JSON.stringify(Object.fromEntries(Object.entries(thresholds).map(([k, v]) => [k, String(v)]))));
    sets.push(`partition_low_thresholds = $${values.length}::jsonb`);
  }
  if (sets.length === 0) throw new TreasuryError(400, 'nothing to change');
  values.push(actor);
  const row = (await client.query(
    `UPDATE treasury.account_config SET ${sets.join(', ')}, actor = $${values.length}, updated_at = NOW()
     WHERE account_id = $1 RETURNING *`, values)).rows[0];
  if (!row) throw new TreasuryError(404, `Unknown account ${c.accountId}`);
  return row;
}

export async function reconDetail(client: PoolClient, accountId: number) {
  const checks = (await client.query(
    `SELECT venue_key, listing_ids, venue_qty, ledger_qty, status, consecutive_mismatches, first_mismatch_at, checked_at
     FROM treasury.position_check WHERE account_id = $1
     ORDER BY (status = 'OK'), first_mismatch_at NULLS LAST, venue_key`, [accountId])).rows;
  const runs = (await client.query(
    `SELECT run_id, ran_at, expected_cash, venue_cash, cash_diff, cash_status, positions_checked, position_breaks
     FROM treasury.recon_run WHERE account_id = $1 ORDER BY ran_at DESC, run_id DESC LIMIT 100`, [accountId])).rows;
  return { accountId, positions: checks, runs };
}

export async function transfers(client: PoolClient, accountId: number | null) {
  return (await client.query(
    `SELECT t.*, a.label FROM treasury.transfer t JOIN account_master.venue_account a USING (account_id)
     WHERE ($1::int IS NULL OR t.account_id = $1) ORDER BY t.occurred_at DESC, t.transfer_id DESC LIMIT 500`,
    [accountId])).rows;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const cognito = (event.resource ?? '').startsWith('/cognito/');
  const resource = (event.resource ?? '').replace(/^\/cognito\//, '/');
  const route = `${event.httpMethod} ${resource}`;
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  const now = new Date();
  try {
    const accountParam = event.queryStringParameters?.accountId;
    const accountId = accountParam ? Number(accountParam) : null;
    if (accountId !== null && !isPositiveInt(accountId)) return createResponse(400, { message: 'accountId must be a positive integer' });
    switch (route) {
      case 'POST /treasury/snapshots': {
        const actor = cognito ? getActor(event) : null;
        const snapshot = parseSnapshot(event.body ?? '', cognito ? 'MANUAL' : 'POLLER', actor);
        return createResponse(200, await withTransaction(client, (c) => recordSnapshot(c, snapshot, now)));
      }
      case 'GET /treasury/poll-targets':
        return createResponse(200, await pollTargets(client));
      case 'POST /ledger/poller-marks':
        return createResponse(200, await withTransaction(client, (c) => recordPollerMarks(c, event.body ?? '', now)));
      case 'GET /treasury/summary':
        return createResponse(200, await summary(client, now));
      case 'GET /treasury/transfers':
        return createResponse(200, await transfers(client, accountId));
      case 'POST /treasury/transfers':
        return createResponse(200, await withTransaction(client, (c) => recordTransfer(c, event.body ?? '', getActor(event))));
      case 'PUT /treasury/account-config':
        return createResponse(200, await withTransaction(client, (c) => updateConfig(c, event.body ?? '', getActor(event))));
      case 'GET /treasury/recon':
        if (accountId === null) return createResponse(400, { message: 'accountId is required' });
        return createResponse(200, await reconDetail(client, accountId));
      default:
        return createResponse(400, { message: `Unsupported ${route}` });
    }
  } catch (error) {
    if (error instanceof TreasuryError) return createResponse(error.statusCode, { message: error.message });
    if (error instanceof PollerMarksError) return createResponse(400, { message: error.message });
    if (error instanceof SyntaxError) return createResponse(400, { message: 'Body is not valid JSON' });
    const message = error instanceof Error ? error.message : String(error);
    console.error('Treasury error:', message);
    return createResponse(500, { message });
  } finally {
    client.release();
  }
};
