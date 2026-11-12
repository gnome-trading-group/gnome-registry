import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { getActor, isService, withTransaction } from './base';
import { connectLedgerDatabase, createResponse, isPositiveInt } from './ledger-common';
import { PollerMarksError, recordPollerMarks } from './ledger-poller-marks';
import { accountTreasury, CREDIT_PROGRAMS, parseSnapshot, recordSnapshot, TreasuryError } from './treasury';

// The treasury's routes. The venue poller posts snapshots and reads which accounts to poll with the API key; an
// operator's manual snapshot, transfers and account settings are Cognito only, so each is attributed to a person. The
// mark poller's route (ledger-poller-marks.ts) is served here too.

const TRANSFER_KINDS = ['OPENING', 'DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'REWARD', 'FEE_ADJUSTMENT', 'CORRECTION'];
// The venue poller books these exchanges' deposits and withdrawals itself, so a person recording one too would count
// it twice; one the poller can't see is recorded as a CORRECTION.
const POLLED_MOVES = ['KALSHI', 'POLYMARKET_INTL', 'POLYMARKET_US'];
// Credits are read again from a little before the newest one booked, in case the venue lists one late; the venue id
// on each keeps a second reading from booking it twice.
const CREDIT_OVERLAP = '3 days';
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
    `SELECT a.account_id, a.exchange_id, e.exchange_code, a.label, a.venue_ref, a.read_secret_name,
       c.partition_targets, COALESCE(c.rebalance_reservation, 'sum') AS rebalance_reservation,
       CASE WHEN c.recon_since IS NOT NULL THEN LEAST(NOW(), GREATEST(c.recon_since,
         (SELECT MAX(t.occurred_at) FROM treasury.transfer t WHERE t.account_id = a.account_id AND t.actor = 'venue-poller')
           - $1::interval)) END AS credits_since,
       COALESCE((SELECT json_agg(json_build_object('external_ref', t.external_ref, 'program', t.program,
                   'occurred_at', t.occurred_at, 'amount', t.amount::text) ORDER BY t.occurred_at)
                 FROM treasury.transfer t WHERE t.account_id = a.account_id AND t.allocation_state = 'PENDING'),
                '[]') AS pending_credits
     FROM account_master.venue_account a JOIN sm.exchange e USING (exchange_id)
     LEFT JOIN treasury.account_config c USING (account_id)
     WHERE a.status IN ('PROVISIONING', 'ACTIVE', 'DRAINING') ORDER BY a.account_id`, [CREDIT_OVERLAP])).rows;
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
    program?: string | null;
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
  const program = t.program ?? null;
  if (program !== null && !CREDIT_PROGRAMS.includes(program)) {
    throw new TreasuryError(400, `program must be one of ${CREDIT_PROGRAMS.join(', ')}`);
  }
  if (program !== null && t.kind !== 'REWARD' && t.kind !== 'INTEREST') {
    throw new TreasuryError(400, 'only a REWARD or INTEREST names a program');
  }
  if (t.kind === 'DEPOSIT' || t.kind === 'WITHDRAWAL') {
    const exchange = (await client.query(
      `SELECT e.exchange_code FROM account_master.venue_account a JOIN sm.exchange e USING (exchange_id)
       WHERE a.account_id = $1`, [t.accountId])).rows[0];
    if (exchange && POLLED_MOVES.includes(exchange.exchange_code)) {
      throw new TreasuryError(400, `the venue poller books ${exchange.exchange_code} deposits and withdrawals; `
        + 'record one it can\'t see as a CORRECTION');
    }
  }
  try {
    const row = (await client.query(
      `INSERT INTO treasury.transfer (account_id, kind, amount, occurred_at, external_ref, reason, actor, program)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [t.accountId, t.kind, String(t.amount), occurredAt, t.externalRef ?? null, t.reason, actor, program])).rows[0];
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
    if (code === '23505') throw new TreasuryError(409, `account ${t.accountId} already has a transfer ${t.externalRef}`);
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
  if (c.partitionTargets !== undefined) {
    const targets = c.partitionTargets;
    if (targets !== null) {
      const entries = typeof targets === 'object' && !Array.isArray(targets) ? Object.entries(targets) : null;
      if (!entries || entries.some(([k, v]) => !/^\d+$/.test(k) || !Number.isInteger(v) || (v as number) < 0
        || (v as number) > 100)) {
        throw new TreasuryError(400, 'partitionTargets maps shard numbers to whole percents, or is null');
      }
      const total = entries.reduce((sum, [, v]) => sum + (v as number), 0);
      if (entries.length > 0 && total !== 100) {
        throw new TreasuryError(400, `partitionTargets must add up to 100 (or be empty to turn rebalancing off), not ${total}`);
      }
    }
    values.push(targets === null ? null : JSON.stringify(targets));
    sets.push(`partition_targets = $${values.length}::jsonb`);
  }
  if (c.rebalanceReservation !== undefined) {
    if (!['none', 'max', 'sum'].includes(String(c.rebalanceReservation))) {
      throw new TreasuryError(400, 'rebalanceReservation must be none, max or sum');
    }
    values.push(c.rebalanceReservation);
    sets.push(`rebalance_reservation = $${values.length}`);
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

export interface TransferFilters {
  accountId: number | null;
  kind?: string;
  program?: string;
  since?: Date;
  strategyId?: number;
}

export function parseTransferFilters(params: Record<string, string | undefined>, accountId: number | null): TransferFilters {
  const filters: TransferFilters = { accountId };
  if (params.kind) {
    if (!TRANSFER_KINDS.includes(params.kind)) throw new TreasuryError(400, `kind must be one of ${TRANSFER_KINDS.join(', ')}`);
    filters.kind = params.kind;
  }
  if (params.program) {
    if (!CREDIT_PROGRAMS.includes(params.program)) {
      throw new TreasuryError(400, `program must be one of ${CREDIT_PROGRAMS.join(', ')}`);
    }
    filters.program = params.program;
  }
  if (params.since) {
    const since = new Date(params.since);
    if (Number.isNaN(since.getTime())) throw new TreasuryError(400, 'since must be a timestamp');
    filters.since = since;
  }
  if (params.strategyId) {
    const strategyId = Number(params.strategyId);
    if (!isPositiveInt(strategyId)) throw new TreasuryError(400, 'strategyId must be a positive integer');
    filters.strategyId = strategyId;
  }
  return filters;
}

// Newest first, each with the parts of it given to strategies. A strategy filter keeps the transfers it was given part of.
export async function transfers(client: PoolClient, f: TransferFilters) {
  return (await client.query(
    `SELECT t.*, a.label, e.exchange_code,
       COALESCE((SELECT json_agg(json_build_object('allocationId', al.allocation_id, 'strategyId', al.strategy_id,
                   'listingId', al.listing_id, 'venueMarket', al.venue_market, 'amount', al.amount::text,
                   'basis', al.basis, 'strategies', al.strategies, 'periodStart', al.period_start,
                   'periodEnd', al.period_end, 'earnedFrom', al.earned_from, 'earnedTo', al.earned_to)
                   ORDER BY al.allocation_id)
                 FROM treasury.transfer_allocation al WHERE al.transfer_id = t.transfer_id), '[]') AS allocations
     FROM treasury.transfer t
     JOIN account_master.venue_account a USING (account_id)
     JOIN sm.exchange e ON e.exchange_id = a.exchange_id
     WHERE ($1::int IS NULL OR t.account_id = $1) AND ($2::text IS NULL OR t.kind = $2)
       AND ($3::text IS NULL OR t.program = $3) AND ($4::timestamptz IS NULL OR t.occurred_at >= $4)
       AND ($5::int IS NULL OR EXISTS (SELECT 1 FROM treasury.transfer_allocation al
                                       WHERE al.transfer_id = t.transfer_id AND al.strategy_id = $5))
     ORDER BY t.occurred_at DESC, t.transfer_id DESC LIMIT 500`,
    [f.accountId, f.kind ?? null, f.program ?? null, f.since ?? null, f.strategyId ?? null])).rows;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const resource = event.resource ?? '';
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
        const manual = !isService(event);
        const snapshot = parseSnapshot(event.body ?? '', manual ? 'MANUAL' : 'POLLER', manual ? getActor(event) : null);
        return createResponse(200, await withTransaction(client, (c) => recordSnapshot(c, snapshot, now)));
      }
      case 'GET /treasury/poll-targets':
        return createResponse(200, await pollTargets(client));
      case 'POST /ledger/poller-marks':
        return createResponse(200, await withTransaction(client, (c) => recordPollerMarks(c, event.body ?? '', now)));
      case 'GET /treasury/summary':
        return createResponse(200, await summary(client, now));
      case 'GET /treasury/transfers':
        return createResponse(200, await transfers(client, parseTransferFilters(event.queryStringParameters ?? {}, accountId)));
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
