import { PoolClient } from 'pg';
import { abs, committedCapital, notional, PRICE_SCALE, toBigInt } from './ledger-math';

// Reconciles each venue account against the ledger. Money is in price units (1e9 per dollar), quantities in size
// units (1e6 per unit).
//
// Cash: what the account should hold is its transfers, plus the cash every live fill on it moved (a buy pays its
// notional, a sell receives it, both pay their fee), plus what the venue does that the ledger books later or not at
// all: Kalshi and Polymarket US pay out $1 as soon as one account holds both sides of a market and charge $1 for a
// short (Kalshi books it as a NO; Polymarket US holds it as margin, which the poller counts as spent), and every
// venue credits a settled market before the sweeper books its SETTLEMENT. The venue's
// side counts resolved Polymarket positions waiting to be redeemed as the cash they will become.
//
// Positions: what the venue holds on each market against the ledger's live positions on the account, summed across
// strategies. A Kalshi market is one signed position (YES positive, NO negative), so its ledger side is YES - NO.
//
// A difference is only a BREAK once it is seen twice, minutes apart, with nothing booked in between that would
// explain it (or the same difference both times): fills land in the ledger a moment after the venue sees them.

const BOOKED_SOURCES = ['VENUE', 'RECOVERY', 'MANUAL', 'SETTLEMENT'];
const BREAK_AFTER_MS = 5 * 60_000;
const SIGNED_POSITION_VENUES = ['KALSHI', 'POLYMARKET_US'];

export interface VenuePositionInput {
  venueKey: string;
  quantity: string | number;
  redeemable?: boolean;
  value?: string | number | null;
}

export interface SnapshotInput {
  accountId: number;
  source: 'POLLER' | 'MANUAL';
  status: 'OK' | 'ERROR';
  error?: string | null;
  cashTotal?: string | number | null;
  cashAvailable?: string | number | null;
  portfolioValue?: string | number | null;
  redeemableValue?: string | number | null;
  cashByPartition?: Record<string, string | number> | null;
  // Null when the venue can't list positions: then only cash is reconciled.
  positions?: VenuePositionInput[] | null;
  raw?: unknown;
  actor?: string | null;
}

export class TreasuryError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function scaled(name: string, value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  if (!/^-?\d+$/.test(String(value))) throw new TreasuryError(400, `${name} must be an integer in its scaled units`);
  return BigInt(String(value));
}

export function parseSnapshot(body: string, source: 'POLLER' | 'MANUAL', actor: string | null): SnapshotInput {
  const s = JSON.parse(body) as SnapshotInput;
  if (!Number.isInteger(s.accountId) || s.accountId <= 0) throw new TreasuryError(400, 'accountId must be a positive integer');
  if (s.status !== 'OK' && s.status !== 'ERROR') throw new TreasuryError(400, 'status must be OK or ERROR');
  if (s.status === 'OK' && scaled('cashTotal', s.cashTotal) === null) throw new TreasuryError(400, 'cashTotal is required');
  for (const key of ['cashTotal', 'cashAvailable', 'portfolioValue', 'redeemableValue'] as const) scaled(key, s[key]);
  for (const [partition, cash] of Object.entries(s.cashByPartition ?? {})) scaled(`cashByPartition.${partition}`, cash);
  for (const p of s.positions ?? []) {
    if (typeof p.venueKey !== 'string' || p.venueKey.length === 0) throw new TreasuryError(400, 'positions need a venueKey');
    scaled('quantity', p.quantity);
    scaled('value', p.value);
  }
  return { ...s, source, actor };
}

// The venue's key for a listing and the sign its position carries there. Kalshi (TICKER:yes|no) and Polymarket US
// (slug:long|short) hold one signed position per market, the NO or short side negative; Polymarket Intl
// (condition:token) holds each outcome token as its own position, keyed by the token.
export function venueKeyOf(exchangeCode: string, exchangeSecurityId: string): { key: string; sign: bigint } {
  const colon = exchangeSecurityId.indexOf(':');
  if (exchangeCode === 'POLYMARKET_INTL') {
    return { key: colon < 0 ? exchangeSecurityId : exchangeSecurityId.slice(colon + 1), sign: 1n };
  }
  const key = colon < 0 ? exchangeSecurityId : exchangeSecurityId.slice(0, colon);
  const side = colon < 0 ? '' : exchangeSecurityId.slice(colon + 1);
  return { key, sign: side === 'no' || side === 'short' ? -1n : 1n };
}

interface AccountRow {
  account_id: number;
  exchange_id: number;
  exchange_code: string;
  label: string;
  recon_since: Date | null;
  recon_enabled: boolean;
  cash_tolerance: string;
  settlement_grace_ms: number;
}

async function loadAccount(client: PoolClient, accountId: number): Promise<AccountRow> {
  const row = (await client.query(
    `SELECT a.account_id, a.exchange_id, e.exchange_code, a.label, c.recon_since, c.recon_enabled, c.cash_tolerance,
       (EXTRACT(EPOCH FROM c.settlement_grace) * 1000)::bigint AS settlement_grace_ms
     FROM account_master.venue_account a
     JOIN sm.exchange e USING (exchange_id)
     JOIN treasury.account_config c USING (account_id)
     WHERE a.account_id = $1`, [accountId])).rows[0];
  if (!row) throw new TreasuryError(404, `Unknown account ${accountId}`);
  return { ...row, settlement_grace_ms: Number(row.settlement_grace_ms) };
}

async function fingerprint(client: PoolClient, accountId: number): Promise<string> {
  const row = (await client.query(
    `SELECT (SELECT COALESCE(MAX(fill_id), 0) FROM ledger.fill WHERE account_id = $1) AS fill,
            (SELECT COALESCE(MAX(transfer_id), 0) FROM treasury.transfer WHERE account_id = $1) AS transfer`,
    [accountId])).rows[0];
  return `${row.fill}:${row.transfer}`;
}

// Each market's two sides, summed across the account's strategies, as of a moment (null = now): YES and NO on
// Kalshi, long and short on Polymarket US. Both venues hold one signed position per market, so a pair pays its
// dollar back at once, and a short costs one.
async function marketPairs(client: PoolClient, account: AccountRow, at: Date | null): Promise<bigint> {
  const accountId = account.account_id;
  const rows = (await client.query(
    `WITH held AS (
       SELECT DISTINCT ON (f.strategy_id, f.listing_id) f.listing_id, f.net_quantity_after AS net
       FROM ledger.fill f
       WHERE f.account_id = $1 AND f.mode = 'live' AND f.source <> 'GAP' AND ($2::timestamptz IS NULL OR f.recorded_at < $2)
       ORDER BY f.strategy_id, f.listing_id, f.fill_id DESC
     )
     SELECT l.exchange_security_id, SUM(h.net) AS net FROM held h JOIN sm.listing l USING (listing_id)
     GROUP BY l.exchange_security_id`,
    [accountId, at])).rows;
  const markets = new Map<string, { yes: bigint; no: bigint }>();
  for (const r of rows) {
    const { key, sign } = venueKeyOf(account.exchange_code, r.exchange_security_id ?? '');
    const market = markets.get(key) ?? { yes: 0n, no: 0n };
    if (sign < 0n) market.no += toBigInt(r.net);
    else market.yes += toBigInt(r.net);
    markets.set(key, market);
  }
  let paired = 0n;
  for (const m of markets.values()) paired += notional(PRICE_SCALE, m.yes < m.no ? m.yes : m.no);
  return paired;
}

export interface CashExpectation {
  expected: bigint;
  // Payouts on markets settled within the venue's grace period: a difference no larger than these is the venue
  // not having paid yet.
  unpaidWithinGrace: bigint;
}

export async function expectedCash(client: PoolClient, account: AccountRow, now: Date): Promise<CashExpectation> {
  const since = account.recon_since as Date;
  const flows = (await client.query(
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM treasury.transfer WHERE account_id = $1 AND occurred_at >= $2) AS transfers,
       (SELECT COALESCE(SUM(
          CASE WHEN side = 1 THEN TRUNC(fill_qty::numeric * fill_price / 1000000)
               ELSE -TRUNC(fill_qty::numeric * fill_price / 1000000) END - COALESCE(fee, 0)), 0)
        FROM ledger.fill
        WHERE account_id = $1 AND mode = 'live' AND source = ANY($3::text[]) AND recorded_at >= $2
          AND fill_qty IS NOT NULL) AS fills`,
    [account.account_id, since, BOOKED_SOURCES])).rows[0];
  let expected = toBigInt(flows.transfers) + toBigInt(flows.fills);
  if (SIGNED_POSITION_VENUES.includes(account.exchange_code)) {
    expected += await marketPairs(client, account, null) - await marketPairs(client, account, since);
  }
  const settled = (await client.query(
    `SELECT p.net_quantity, ec.settlement_price, ec.settled_at
     FROM ledger.position p
     JOIN sm.listing l ON l.listing_id = p.listing_id
     JOIN LATERAL (
       SELECT settlement_price, settled_at FROM sm.event_contract
       WHERE security_id = l.security_id AND settlement_price IS NOT NULL LIMIT 1
     ) ec ON TRUE
     WHERE p.account_id = $1 AND p.mode = 'live' AND p.net_quantity <> 0`,
    [account.account_id])).rows;
  let unpaidWithinGrace = 0n;
  for (const s of settled) {
    const payout = notional(toBigInt(s.settlement_price), toBigInt(s.net_quantity));
    expected += payout;
    if (now.getTime() - s.settled_at.getTime() < account.settlement_grace_ms) unpaidWithinGrace += abs(payout);
  }
  return { expected, unpaidWithinGrace };
}

type CheckStatus = 'OK' | 'PENDING' | 'BREAK';

// Out of tolerance twice, at least BREAK_AFTER_MS apart, with the ledger unchanged in between or the difference the
// same both times. A first sighting, or a second too soon, stays PENDING.
function judge(
  diff: bigint, tolerance: bigint, fp: string, now: Date,
  previous: { status: string; fingerprint: string | null; diff: bigint; since: Date | null } | undefined,
): { status: CheckStatus; since: Date | null } {
  if (abs(diff) <= tolerance) return { status: 'OK', since: null };
  if (!previous || previous.status === 'OK' || previous.since === null) return { status: 'PENDING', since: now };
  const explained = previous.fingerprint !== fp && abs(diff - previous.diff) > tolerance;
  if (explained) return { status: 'PENDING', since: now };
  return { status: now.getTime() - previous.since.getTime() >= BREAK_AFTER_MS ? 'BREAK' : 'PENDING', since: previous.since };
}

async function reconcileCash(
  client: PoolClient, account: AccountRow, snapshotId: number, venueCash: bigint, fp: string, now: Date,
): Promise<{ status: string; expected: bigint | null; diff: bigint | null }> {
  if (!account.recon_enabled || account.recon_since === null) return { status: 'OFF', expected: null, diff: null };
  const { expected, unpaidWithinGrace } = await expectedCash(client, account, now);
  const diff = venueCash - expected;
  const previousRow = (await client.query(
    `SELECT cash_status, ledger_fingerprint, cash_diff, ran_at,
       (SELECT MIN(r2.ran_at) FROM treasury.recon_run r2
        WHERE r2.account_id = r.account_id AND r2.cash_status IN ('PENDING', 'BREAK')
          AND r2.ran_at > COALESCE((SELECT MAX(r3.ran_at) FROM treasury.recon_run r3
                                    WHERE r3.account_id = r.account_id AND r3.cash_status IN ('OK', 'OFF')),
                                   '-infinity')) AS since
     FROM treasury.recon_run r WHERE account_id = $1 AND cash_status <> 'ERROR'
     ORDER BY ran_at DESC, run_id DESC LIMIT 1`, [account.account_id])).rows[0];
  const previous = previousRow && {
    status: previousRow.cash_status, fingerprint: previousRow.ledger_fingerprint,
    diff: toBigInt(previousRow.cash_diff), since: previousRow.since,
  };
  let { status } = judge(diff, toBigInt(account.cash_tolerance), fp, now, previous);
  if (status === 'BREAK' && abs(diff) <= toBigInt(account.cash_tolerance) + unpaidWithinGrace) status = 'PENDING';
  return { status, expected, diff };
}

async function checkPositions(
  client: PoolClient, account: AccountRow, venue: VenuePositionInput[], fp: string, now: Date,
): Promise<{ checked: number; breaks: number }> {
  const ledgerRows = (await client.query(
    `SELECT l.exchange_security_id, l.listing_id, SUM(p.net_quantity) AS net,
       BOOL_OR(ec.settlement_price IS NOT NULL) AS settled
     FROM ledger.position p
     JOIN sm.listing l ON l.listing_id = p.listing_id
     LEFT JOIN LATERAL (
       SELECT settlement_price FROM sm.event_contract WHERE security_id = l.security_id LIMIT 1
     ) ec ON TRUE
     WHERE p.account_id = $1 AND p.mode = 'live'
     GROUP BY l.exchange_security_id, l.listing_id`, [account.account_id])).rows;
  const known = (await client.query(
    `SELECT l.exchange_security_id, l.listing_id,
       EXISTS (SELECT 1 FROM sm.event_contract ec WHERE ec.security_id = l.security_id AND ec.settlement_price IS NOT NULL)
         AS settled
     FROM sm.listing l WHERE l.exchange_id = $1`, [account.exchange_id])).rows;

  const ledger = new Map<string, { qty: bigint; listings: number[]; settled: boolean }>();
  for (const r of ledgerRows) {
    const { key, sign } = venueKeyOf(account.exchange_code, r.exchange_security_id ?? '');
    const entry = ledger.get(key) ?? { qty: 0n, listings: [], settled: false };
    entry.qty += sign * toBigInt(r.net);
    entry.listings.push(r.listing_id);
    entry.settled = entry.settled || r.settled;
    ledger.set(key, entry);
  }
  const listingsByKey = new Map<string, { listings: number[]; settled: boolean }>();
  for (const r of known) {
    const { key } = venueKeyOf(account.exchange_code, r.exchange_security_id ?? '');
    const entry = listingsByKey.get(key) ?? { listings: [], settled: false };
    entry.listings.push(r.listing_id);
    entry.settled = entry.settled || r.settled;
    listingsByKey.set(key, entry);
  }
  const venueByKey = new Map<string, VenuePositionInput>();
  for (const p of venue) venueByKey.set(p.venueKey, p);

  const previous = new Map((await client.query(
    `SELECT venue_key, venue_qty, ledger_qty, ledger_fingerprint, status, first_mismatch_at
     FROM treasury.position_check WHERE account_id = $1`, [account.account_id])).rows.map(r => [r.venue_key, r]));

  let checked = 0;
  let breaks = 0;
  // What was checked before too: a market closed outside the ledger leaves both sides empty, and only judging it
  // again clears what it was flagged for.
  const keys = new Set([...ledger.keys(), ...venueByKey.keys(), ...previous.keys()]);
  for (const key of keys) {
    const held = ledger.get(key);
    const reported = venueByKey.get(key);
    const listing = listingsByKey.get(key);
    // A settled market's positions close by settlement on both sides, at different moments; cash covers it. It is no
    // longer checked, so what it was flagged for goes too.
    if (held?.settled || listing?.settled || reported?.redeemable) {
      if (previous.has(key)) {
        await client.query('DELETE FROM treasury.position_check WHERE account_id = $1 AND venue_key = $2',
          [account.account_id, key]);
      }
      continue;
    }
    const venueQty = reported ? toBigInt(reported.quantity) : 0n;
    const ledgerQty = held?.qty ?? 0n;
    let status: string;
    let since: Date | null;
    if (!listing && !held && venueQty !== 0n) {
      status = 'UNKNOWN_VENUE_POSITION';
      since = previous.get(key)?.first_mismatch_at ?? now;
    } else {
      const prior = previous.get(key);
      ({ status, since } = judge(venueQty - ledgerQty, 0n, fp, now, prior && {
        status: prior.status, fingerprint: prior.ledger_fingerprint,
        diff: toBigInt(prior.venue_qty) - toBigInt(prior.ledger_qty), since: prior.first_mismatch_at,
      }));
    }
    checked++;
    if (status === 'BREAK' || status === 'UNKNOWN_VENUE_POSITION') breaks++;
    await client.query(
      `INSERT INTO treasury.position_check (account_id, venue_key, listing_ids, venue_qty, ledger_qty, ledger_fingerprint,
         status, consecutive_mismatches, first_mismatch_at, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, CASE WHEN $7::varchar = 'OK' THEN 0 ELSE 1 END, $8, $9)
       ON CONFLICT (account_id, venue_key) DO UPDATE SET listing_ids = EXCLUDED.listing_ids,
         venue_qty = EXCLUDED.venue_qty, ledger_qty = EXCLUDED.ledger_qty, ledger_fingerprint = EXCLUDED.ledger_fingerprint,
         status = EXCLUDED.status, first_mismatch_at = EXCLUDED.first_mismatch_at, checked_at = EXCLUDED.checked_at,
         consecutive_mismatches = CASE WHEN EXCLUDED.status = 'OK' THEN 0
                                       ELSE treasury.position_check.consecutive_mismatches + 1 END`,
      [account.account_id, key, held?.listings ?? listing?.listings ?? [], venueQty.toString(), ledgerQty.toString(), fp,
        status, since, now]);
  }
  return { checked, breaks };
}

// Records one reading of an account and reconciles it, in the caller's transaction.
export async function recordSnapshot(client: PoolClient, input: SnapshotInput, now: Date) {
  const account = await loadAccount(client, input.accountId);
  const snapshot = (await client.query(
    `INSERT INTO treasury.balance_snapshot (account_id, taken_at, source, status, error, cash_total, cash_available,
       portfolio_value, redeemable_value, raw, actor, cash_by_partition)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING snapshot_id`,
    [input.accountId, now, input.source, input.status, input.error ?? null, scaled('cashTotal', input.cashTotal)?.toString(),
      scaled('cashAvailable', input.cashAvailable)?.toString(), scaled('portfolioValue', input.portfolioValue)?.toString(),
      scaled('redeemableValue', input.redeemableValue)?.toString(), input.raw === undefined ? null : JSON.stringify(input.raw),
      input.actor ?? null,
      input.cashByPartition == null ? null : JSON.stringify(Object.fromEntries(
        Object.entries(input.cashByPartition).map(([k, v]) => [k, String(v)])))])).rows[0];
  if (input.status === 'ERROR') {
    await client.query(
      `INSERT INTO treasury.recon_run (account_id, snapshot_id, ran_at, cash_status) VALUES ($1, $2, $3, 'ERROR')`,
      [input.accountId, snapshot.snapshot_id, now]);
    return { snapshotId: snapshot.snapshot_id, cashStatus: 'ERROR', positionsChecked: 0, positionBreaks: 0 };
  }
  for (const p of input.positions ?? []) {
    await client.query(
      `INSERT INTO treasury.venue_position (snapshot_id, venue_key, quantity, redeemable, value) VALUES ($1, $2, $3, $4, $5)`,
      [snapshot.snapshot_id, p.venueKey, String(p.quantity), p.redeemable ?? false, p.value == null ? null : String(p.value)]);
  }
  const fp = await fingerprint(client, input.accountId);
  const venueCash = (scaled('cashTotal', input.cashTotal) as bigint) + (scaled('redeemableValue', input.redeemableValue) ?? 0n);
  const cash = await reconcileCash(client, account, snapshot.snapshot_id, venueCash, fp, now);
  const positions = input.positions == null
    ? { checked: 0, breaks: 0 }
    : await checkPositions(client, account, input.positions, fp, now);
  await client.query(
    `INSERT INTO treasury.recon_run (account_id, snapshot_id, ran_at, expected_cash, venue_cash, cash_diff, cash_status,
       ledger_fingerprint, positions_checked, position_breaks)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [input.accountId, snapshot.snapshot_id, now, cash.expected?.toString() ?? null, venueCash.toString(),
      cash.diff?.toString() ?? null, cash.status, fp, positions.checked, positions.breaks]);
  // TODO(generic-alerting): push a RECON_MISMATCH alert when the cash or a position first turns BREAK.
  return {
    snapshotId: snapshot.snapshot_id, cashStatus: cash.status, cashDiff: cash.diff?.toString() ?? null,
    positionsChecked: positions.checked, positionBreaks: positions.breaks,
  };
}

export interface AccountTreasury {
  accountId: number;
  exchangeId: number;
  exchangeCode: string;
  label: string;
  status: string;
  snapshotAt: Date | null;
  snapshotFresh: boolean;
  // The latest reading of any outcome: when it failed, why, so a page can say what keeps the account unread.
  lastReadingAt: Date | null;
  lastReadingError: string | null;
  cashTotal: bigint;
  cashAvailable: bigint;
  portfolioValue: bigint;
  redeemable: bigint;
  // What live positions on the account cost, and with their working orders, what they tie up.
  heldAtCost: bigint;
  committed: bigint;
  // Cash, redeemable payouts, and positions at cost: the money behind the account's allocations.
  base: bigint;
  // Each active live session's budget, plus what positions no running session holds still tie up.
  allocated: bigint;
  minBuffer: bigint;
  free: bigint;
  lowBalanceThreshold: bigint;
  // The latest reading's cash per partition (Kalshi shards), and the thresholds set for them; null where unsplit.
  cashByPartition: Record<string, bigint> | null;
  partitionLowThresholds: Record<string, bigint>;
}

// Where each account stands: its latest good reading, what the ledger says is tied up on it, and how much of it the
// running sessions' budgets claim.
export async function accountTreasury(client: PoolClient, accountIds: number[] | null, now: Date): Promise<AccountTreasury[]> {
  const accounts = (await client.query(
    `SELECT a.account_id, a.exchange_id, e.exchange_code, a.label, a.status, c.min_buffer, c.low_balance_threshold,
       c.partition_low_thresholds, s.taken_at, s.cash_total, s.cash_available, s.portfolio_value, s.redeemable_value,
       s.cash_by_partition, r.taken_at AS last_reading_at, CASE WHEN r.status = 'ERROR' THEN COALESCE(r.error, 'unknown error') END
         AS last_reading_error,
       (s.taken_at IS NOT NULL AND s.taken_at >= $2::timestamptz - c.snapshot_max_age) AS fresh
     FROM account_master.venue_account a
     JOIN sm.exchange e USING (exchange_id)
     JOIN treasury.account_config c USING (account_id)
     LEFT JOIN LATERAL (
       SELECT * FROM treasury.balance_snapshot b WHERE b.account_id = a.account_id AND b.status = 'OK'
       ORDER BY taken_at DESC LIMIT 1
     ) s ON TRUE
     LEFT JOIN LATERAL (
       SELECT taken_at, status, error FROM treasury.balance_snapshot b WHERE b.account_id = a.account_id
       ORDER BY taken_at DESC, snapshot_id DESC LIMIT 1
     ) r ON TRUE
     WHERE ($1::int[] IS NULL OR a.account_id = ANY($1::int[])) AND a.status <> 'RETIRED'
     ORDER BY a.exchange_id, a.label`, [accountIds, now])).rows;
  if (accounts.length === 0) return [];
  const ids = accounts.map(a => a.account_id);

  const positions = (await client.query(
    `SELECT p.account_id, p.strategy_id, p.listing_id, p.net_quantity, p.total_cost,
       (s.type = 4 AND s.contract_type IN (7, 8)) AS binary,
       COALESCE(o.buy_qty, 0) AS buy_qty, COALESCE(o.buy_notional, 0) AS buy_notional,
       COALESCE(o.sell_qty, 0) AS sell_qty, COALESCE(o.sell_notional, 0) AS sell_notional,
       EXISTS (SELECT 1 FROM strategy.session_listing sl
               JOIN account_master.session_venue_account sva ON sva.session_id = sl.session_id
                 AND sva.account_id = p.account_id
               WHERE sl.strategy_id = p.strategy_id AND sl.listing_id = p.listing_id AND sl.mode = 'live'
                 AND sl.active) AS held_by_session
     FROM ledger.position p
     JOIN sm.listing l ON l.listing_id = p.listing_id
     JOIN sm.security s ON s.security_id = l.security_id
     LEFT JOIN LATERAL (
       SELECT
         SUM(CASE WHEN o.side = 0 THEN o.size - COALESCE(o.filled_qty, 0) END) AS buy_qty,
         SUM(CASE WHEN o.side = 0 THEN TRUNC(o.price::numeric * (o.size - COALESCE(o.filled_qty, 0)) / 1000000) END)
           AS buy_notional,
         SUM(CASE WHEN o.side = 1 THEN o.size - COALESCE(o.filled_qty, 0) END) AS sell_qty,
         SUM(CASE WHEN o.side = 1 THEN TRUNC(o.price::numeric * (o.size - COALESCE(o.filled_qty, 0)) / 1000000) END)
           AS sell_notional
       FROM ledger.order o
       WHERE o.account_id = p.account_id AND o.strategy_id = p.strategy_id AND o.listing_id = p.listing_id
         AND o.status = 'OPEN' AND o.price IS NOT NULL AND o.size IS NOT NULL
     ) o ON TRUE
     WHERE p.account_id = ANY($1::int[]) AND p.mode = 'live'`, [ids])).rows;

  const budgets = (await client.query(
    `SELECT sva.account_id, COALESCE(SUM(al.max_capital), 0) AS allocated, COUNT(*) FILTER (WHERE al.max_capital IS NULL)
       AS unbudgeted
     FROM account_master.session_venue_account sva
     JOIN strategy.session s ON s.session_id = sva.session_id
     LEFT JOIN treasury.allocation al ON al.strategy_id = s.strategy_id AND al.exchange_id = sva.exchange_id
     WHERE sva.account_id = ANY($1::int[]) AND s.mode = 'live' AND s.status = ANY($2::text[])
     GROUP BY sva.account_id`, [ids, ['SUBMITTED', 'STARTING', 'RUNNING', 'STOPPING']])).rows;

  return accounts.map(a => {
    let heldAtCost = 0n;
    let committed = 0n;
    let idle = 0n;
    for (const p of positions.filter(p => p.account_id === a.account_id)) {
      const net = toBigInt(p.net_quantity);
      const cost = toBigInt(p.total_cost);
      const held = committedCapital({
        binary: p.binary, netQuantity: net, totalCost: cost, leavesBuyQty: 0n, leavesBuyNotional: 0n,
        leavesSellQty: 0n, leavesSellNotional: 0n,
      });
      const withOrders = committedCapital({
        binary: p.binary, netQuantity: net, totalCost: cost,
        leavesBuyQty: toBigInt(p.buy_qty), leavesBuyNotional: toBigInt(p.buy_notional),
        leavesSellQty: toBigInt(p.sell_qty), leavesSellNotional: toBigInt(p.sell_notional),
      });
      heldAtCost += held;
      committed += withOrders;
      if (!p.held_by_session) idle += withOrders;
    }
    const budget = budgets.find(b => b.account_id === a.account_id);
    const cashTotal = toBigInt(a.cash_total);
    const redeemable = toBigInt(a.redeemable_value);
    const base = cashTotal + redeemable + heldAtCost;
    const allocated = toBigInt(budget?.allocated) + idle;
    const minBuffer = toBigInt(a.min_buffer);
    return {
      accountId: a.account_id, exchangeId: a.exchange_id, exchangeCode: a.exchange_code, label: a.label,
      status: a.status, snapshotAt: a.taken_at, snapshotFresh: a.fresh, lastReadingAt: a.last_reading_at,
      lastReadingError: a.last_reading_error, cashTotal,
      cashAvailable: toBigInt(a.cash_available), portfolioValue: toBigInt(a.portfolio_value), redeemable,
      heldAtCost, committed, base, allocated, minBuffer, free: base - minBuffer - allocated,
      lowBalanceThreshold: toBigInt(a.low_balance_threshold),
      cashByPartition: a.cash_by_partition === null ? null
        : Object.fromEntries(Object.entries(a.cash_by_partition as Record<string, string>).map(([k, v]) => [k, toBigInt(v)])),
      partitionLowThresholds: Object.fromEntries(
        Object.entries((a.partition_low_thresholds ?? {}) as Record<string, string>).map(([k, v]) => [k, toBigInt(v)])),
    };
  });
}
