import { PoolClient } from 'pg';

// A paper session's estimated venue rewards (ledger.reward_accrual, migration 074): snapshots its scorer posts, the
// latest per listing and program, and the deltas between them that paper PnL counts. Amounts are price units.

const MAX_ROWS = 2000;
const NANOS_FIELDS = ['countingNanos', 'oneSidedNanos', 'depthUnknownNanos', 'noDataNanos'] as const;
const AMOUNT_FIELDS = ['gross', 'marketGross', 'marketPaid'] as const;

export interface PostedAccrual {
  listingId: number;
  venueMarket: string;
  venueProgramId: string;
  program: string;
  periodStartMs: number;
  periodEndMs: number | null;
  asOfMs: number;
  gross: string;
  marketGross: string;
  marketPaid: string;
  countingNanos: string;
  oneSidedNanos: string;
  depthUnknownNanos: string;
  noDataNanos: string;
  gaps: number;
}

// Times are epoch milliseconds, which a JSON number holds exactly (nanoseconds wouldn't).
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isCount = (v: unknown): boolean =>
  (typeof v === 'string' && /^\d{1,19}$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

/** The row as stored, or null when it can't be: such a row is skipped, never failing the post. */
export function parseAccrual(raw: unknown): PostedAccrual | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.listingId) || (r.listingId as number) <= 0) return null;
  if (typeof r.venueMarket !== 'string' || r.venueMarket === '') return null;
  if (typeof r.venueProgramId !== 'string' || r.venueProgramId === '') return null;
  if (r.program !== 'LIQUIDITY') return null;
  if (!isTime(r.periodStartMs) || !isTime(r.asOfMs) || (r.periodEndMs != null && !isTime(r.periodEndMs))) return null;
  if (![...AMOUNT_FIELDS, ...NANOS_FIELDS].every(f => isCount(r[f]))) return null;
  if (r.gaps != null && !(Number.isInteger(r.gaps) && (r.gaps as number) >= 0)) return null;
  return {
    listingId: r.listingId as number,
    venueMarket: r.venueMarket,
    venueProgramId: r.venueProgramId,
    program: r.program,
    periodStartMs: r.periodStartMs,
    periodEndMs: r.periodEndMs == null ? null : r.periodEndMs as number,
    asOfMs: r.asOfMs,
    gross: String(r.gross),
    marketGross: String(r.marketGross),
    marketPaid: String(r.marketPaid),
    countingNanos: String(r.countingNanos),
    oneSidedNanos: String(r.oneSidedNanos),
    depthUnknownNanos: String(r.depthUnknownNanos),
    noDataNanos: String(r.noDataNanos),
    gaps: (r.gaps as number | undefined) ?? 0,
  };
}

// Kept only for a paper session that leases the listing (any of its listings, active or not, so a stopping session's
// last post counts); a snapshot already stored is kept once.
const INSERT = `
  INSERT INTO ledger.reward_accrual (session_id, strategy_id, mode, listing_id, exchange_id, venue_market,
    venue_program_id, program, period_start, period_end, as_of, gross, market_gross, market_paid, counting_nanos,
    one_sided_nanos, depth_unknown_nanos, no_data_nanos, gaps)
  SELECT s.session_id, s.strategy_id, s.mode, r."listingId", l.exchange_id, r."venueMarket", r."venueProgramId",
    r.program, to_timestamp(r."periodStartMs" / 1000.0), to_timestamp(r."periodEndMs" / 1000.0),
    to_timestamp(r."asOfMs" / 1000.0), r.gross, r."marketGross", r."marketPaid", r."countingNanos",
    r."oneSidedNanos", r."depthUnknownNanos", r."noDataNanos", r.gaps
  FROM jsonb_to_recordset($2::jsonb) AS r("listingId" int, "venueMarket" text, "venueProgramId" text, program text,
    "periodStartMs" bigint, "periodEndMs" bigint, "asOfMs" bigint, gross bigint, "marketGross" bigint,
    "marketPaid" bigint, "countingNanos" bigint, "oneSidedNanos" bigint, "depthUnknownNanos" bigint,
    "noDataNanos" bigint, gaps int)
  JOIN strategy.session s ON s.session_id = $1 AND s.mode = 'paper'
  JOIN sm.listing l ON l.listing_id = r."listingId"
  WHERE EXISTS (SELECT 1 FROM strategy.session_listing sl
                WHERE sl.session_id = s.session_id AND sl.listing_id = r."listingId")
  ON CONFLICT (session_id, listing_id, venue_program_id, as_of) DO NOTHING`;

export class AccrualPostError extends Error {}

/** Stores a session's snapshots. Rows that don't parse, or aren't the session's to post, are skipped and counted. */
export async function insertAccruals(client: PoolClient, sessionId: unknown, accruals: unknown):
    Promise<{ inserted: number; skipped: number }> {
  if (typeof sessionId !== 'string' || sessionId === '') throw new AccrualPostError('sessionId is required');
  if (!Array.isArray(accruals)) throw new AccrualPostError('accruals must be an array');
  if (accruals.length > MAX_ROWS) throw new AccrualPostError(`at most ${MAX_ROWS} accruals per post`);
  const parsed = accruals.map(parseAccrual).filter((r): r is PostedAccrual => r !== null);
  const inserted = parsed.length === 0 ? 0
    : (await client.query(INSERT, [sessionId, JSON.stringify(parsed)])).rowCount ?? 0;
  return { inserted, skipped: accruals.length - inserted };
}

export interface AccrualSnapshot {
  sessionId: string;
  strategyId: number;
  listingId: number;
  exchangeCode: string;
  venueMarket: string;
  venueProgramId: string;
  program: string;
  periodStart: string;
  periodEnd: string | null;
  asOf: string;
  // The period ended by the session's last snapshot, so market_paid is what the venue would pay.
  closed: boolean;
  gross: string;
  marketGross: string;
  marketPaid: string;
  countingNanos: string;
  oneSidedNanos: string;
  depthUnknownNanos: string;
  noDataNanos: string;
  gaps: number;
}

/** Each session's latest snapshot per listing and program, for one session or one strategy's sessions in a mode. */
export async function latestAccruals(
  client: PoolClient, scope: { sessionId?: string; strategyId?: number; mode?: string },
): Promise<AccrualSnapshot[]> {
  const rows = (await client.query(`
    SELECT DISTINCT ON (ra.session_id, ra.listing_id, ra.venue_program_id)
      ra.*, e.exchange_code
    FROM ledger.reward_accrual ra JOIN sm.exchange e ON e.exchange_id = ra.exchange_id
    WHERE ($1::text IS NULL OR ra.session_id = $1) AND ($2::int IS NULL OR ra.strategy_id = $2)
      AND ($3::text IS NULL OR ra.mode = $3)
    ORDER BY ra.session_id, ra.listing_id, ra.venue_program_id, ra.as_of DESC`,
  [scope.sessionId ?? null, scope.strategyId ?? null, scope.mode ?? null])).rows;
  return rows.map(r => ({
    sessionId: r.session_id,
    strategyId: r.strategy_id,
    listingId: r.listing_id,
    exchangeCode: r.exchange_code,
    venueMarket: r.venue_market,
    venueProgramId: r.venue_program_id,
    program: r.program,
    periodStart: r.period_start.toISOString(),
    periodEnd: r.period_end ? r.period_end.toISOString() : null,
    asOf: r.as_of.toISOString(),
    closed: r.period_end !== null && r.period_end <= r.as_of,
    gross: String(r.gross),
    marketGross: String(r.market_gross),
    marketPaid: String(r.market_paid),
    countingNanos: String(r.counting_nanos),
    oneSidedNanos: String(r.one_sided_nanos),
    depthUnknownNanos: String(r.depth_unknown_nanos),
    noDataNanos: String(r.no_data_nanos),
    gaps: r.gaps,
  }));
}

/**
 * A session's estimate: gross summed over its listings and programs, and what the venue would pay for the periods that
 * ended, counting each market's program once (both of a market's listings carry the market's figure).
 */
export function sessionRewardTotals(snapshots: AccrualSnapshot[]): { gross: bigint; paid: bigint } {
  const gross = snapshots.reduce((sum, s) => sum + BigInt(s.gross), 0n);
  const paidByMarket = new Map<string, bigint>();
  for (const s of snapshots) {
    if (s.closed) paidByMarket.set(`${s.sessionId}\u0000${s.venueMarket}\u0000${s.venueProgramId}`, BigInt(s.marketPaid));
  }
  return { gross, paid: [...paidByMarket.values()].reduce((sum, p) => sum + p, 0n) };
}

/** Each session's gross estimate, from its latest snapshot per listing and program. */
export async function sessionsRewardGross(client: PoolClient, sessionIds: string[]): Promise<Map<string, bigint>> {
  if (sessionIds.length === 0) return new Map();
  const rows = (await client.query(`
    SELECT session_id, SUM(gross)::text AS gross FROM (
      SELECT DISTINCT ON (session_id, listing_id, venue_program_id) session_id, gross
      FROM ledger.reward_accrual WHERE session_id = ANY($1::text[])
      ORDER BY session_id, listing_id, venue_program_id, as_of DESC
    ) latest GROUP BY session_id`,
  [sessionIds])).rows;
  return new Map(rows.map(r => [r.session_id, BigInt(r.gross)]));
}

/** What accrued between a session's consecutive snapshots, up to {@code at}: paper PnL's estimated rewards. */
export async function accrualDeltas(
  client: PoolClient, mode: string, scope: { strategyId: number | null; listingId?: number }, at: Date,
) {
  return (await client.query(`
    SELECT ra.strategy_id, ra.listing_id, ra.venue_market, ra.program, ra.period_start, ra.period_end, ra.as_of,
      e.exchange_code,
      ra.gross - COALESCE(LAG(ra.gross) OVER (
        PARTITION BY ra.session_id, ra.listing_id, ra.venue_program_id ORDER BY ra.as_of), 0) AS amount
    FROM ledger.reward_accrual ra JOIN sm.exchange e ON e.exchange_id = ra.exchange_id
    WHERE ra.mode = $1 AND ra.as_of <= $2 AND ($3::int IS NULL OR ra.strategy_id = $3)
      AND ($4::int IS NULL OR ra.listing_id = $4)
    ORDER BY ra.as_of`,
  [mode, at, scope.strategyId, scope.listingId ?? null])).rows;
}
