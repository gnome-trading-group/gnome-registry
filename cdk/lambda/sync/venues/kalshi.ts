import { fetchWithRetry } from './http';
import { kalshiHeaders } from './signers';
import {
  CreditKind, CreditProgram, PollTarget, PRICE_SCALE, RebalanceReading, RebalanceTargets, sameTargets, scaleDecimal,
  SETTLEMENT_LOOKBACK_MS, SIZE_SCALE, unclassifiedCredit, VenueCredit, VenueReading, VenueSettlement,
} from './types';
import { IncentiveProgramReading } from './types';
import { byEffectiveFrom, feeRate, VenueFeeRead, VenueFeeSchedule } from './fees';
import { IFeeDefinition, IFeeRounding } from '../../fees/definition';
import { PriceBand } from '../../endpoints/price-bands';
import { chunks, complementBands, pause, PRICE_SCALE as SPEC_PRICE_SCALE, ReadOptions, units, VenueSpec } from './specs';

// Kalshi reports money in cents rounded down, and to four decimals in its *_dollars fields, which sub-cent prices
// need; a position per market ticker, signed: YES positive, NO negative. Collateral is split by exchange shard; the
// account's total is what reconciles against the ledger.
const CENT = PRICE_SCALE / 100n;
const PAGE_LIMIT = 1000;

interface Credentials {
  apiKey: string;
  privateKey: string;
}

async function get(baseUrl: string, credentials: Credentials, path: string): Promise<any> {
  const res = await fetchWithRetry(`${baseUrl}${path}`, () => ({
    headers: kalshiHeaders(credentials.apiKey, credentials.privateKey, 'GET', path, Date.now()),
  }));
  if (!res.ok) throw new Error(`Kalshi GET ${path.split('?')[0]} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const TARGETS_PATH = '/trade-api/v2/portfolio/target_balance_allocation';

async function readTargets(baseUrl: string, credentials: Credentials): Promise<RebalanceReading> {
  const res = await fetchWithRetry(`${baseUrl}${TARGETS_PATH}`, () => ({
    headers: kalshiHeaders(credentials.apiKey, credentials.privateKey, 'GET', TARGETS_PATH, Date.now()),
  }));
  if (!res.ok) return { error: `reading the targets failed: ${res.status} ${(await res.text()).slice(0, 300)}` };
  const body = await res.json();
  return {
    allocations: Object.fromEntries((body.allocations ?? []).map(
      (a: { exchange_index: number; percent: number }) => [String(a.exchange_index), Number(a.percent)])),
    restingMarginReservation: String(body.resting_margin_reservation ?? 'sum'),
  };
}

async function writeTargets(baseUrl: string, credentials: Credentials, wanted: RebalanceTargets): Promise<string | null> {
  const body = JSON.stringify({
    allocations: Object.entries(wanted.allocations).filter(([, p]) => p > 0)
      .map(([shard, percent]) => ({ exchange_index: Number(shard), percent })),
    resting_margin_reservation: wanted.restingMarginReservation,
  });
  const res = await fetchWithRetry(`${baseUrl}${TARGETS_PATH}`, () => ({
    method: 'POST',
    headers: {
      ...kalshiHeaders(credentials.apiKey, credentials.privateKey, 'POST', TARGETS_PATH, Date.now()),
      'Content-Type': 'application/json',
    },
    body,
  }));
  return res.ok ? null : `setting the targets failed: ${res.status} ${(await res.text()).slice(0, 300)}`;
}

// Kalshi moves cash between shards on its own every 10 seconds toward the account's targets. Where the account says
// what they should be, a reading that finds them different sets them and reads them again; a failure is recorded on
// the reading, never failing it, since the balances are still good.
async function rebalance(baseUrl: string, credentials: Credentials, target: PollTarget): Promise<RebalanceReading> {
  const found = await readTargets(baseUrl, credentials);
  if (target.partition_targets === null) return found;
  const wanted = { allocations: target.partition_targets, restingMarginReservation: target.rebalance_reservation };
  if (found.allocations !== undefined && sameTargets(found as RebalanceTargets, wanted)) return found;
  const failed = await writeTargets(baseUrl, credentials, wanted);
  if (failed) return { ...found, error: failed };
  return readTargets(baseUrl, credentials);
}

export async function readKalshi(target: PollTarget, credentials: Credentials): Promise<VenueReading> {
  const baseUrl = (process.env.KALSHI_API_URL ?? 'https://external-api.kalshi.com').replace(/\/$/, '');
  const subaccount = target.venue_ref.subaccount;
  const account = subaccount === undefined ? '' : `subaccount=${encodeURIComponent(String(subaccount))}`;
  const balance = await get(baseUrl, credentials, `/trade-api/v2/portfolio/balance${account ? `?${account}` : ''}`);

  const positions: VenueReading['positions'] = [];
  let cursor = '';
  do {
    const query = [`limit=${PAGE_LIMIT}`, 'count_filter=position', account, cursor ? `cursor=${encodeURIComponent(cursor)}` : '']
      .filter(Boolean).join('&');
    const page = await get(baseUrl, credentials, `/trade-api/v2/portfolio/positions?${query}`);
    for (const p of page.market_positions ?? []) {
      const quantity = p.position_fp !== undefined ? scaleDecimal(p.position_fp, SIZE_SCALE) : BigInt(p.position ?? 0) * SIZE_SCALE;
      if (quantity !== 0n) positions.push({ venueKey: p.ticker, quantity, redeemable: false, value: null });
    }
    cursor = page.cursor ?? '';
  } while (cursor);

  const cash = balance.balance_dollars !== undefined
    ? scaleDecimal(balance.balance_dollars, PRICE_SCALE)
    : BigInt(balance.balance) * CENT;
  const portfolioValue = balance.portfolio_value_dollars !== undefined
    ? scaleDecimal(balance.portfolio_value_dollars, PRICE_SCALE)
    : balance.portfolio_value === undefined ? null : BigInt(balance.portfolio_value) * CENT;
  // The balance's own breakdown sums every subaccount and is withheld from subaccount-restricted keys, so the shards
  // are read per subaccount instead. Mid-transfer they needn't add up to the total.
  const subaccountBalances = await get(baseUrl, credentials, '/trade-api/v2/portfolio/subaccounts/balances');
  const rebalanceTargets = await rebalance(baseUrl, credentials, target);
  // Without them recon only waits for the classifier, as it always could; that's no reason to lose the reading.
  let settlementsError: string | undefined;
  const settlements = await readKalshiSettlements(baseUrl, credentials).catch((error: unknown) => {
    settlementsError = error instanceof Error ? error.message : String(error);
    console.error(`Reading ${target.label} settlements failed: ${settlementsError}`);
    return undefined;
  });
  const ours = Number(subaccount ?? 0);
  const cashByPartition: Record<string, bigint> = {};
  for (const shard of subaccountBalances.subaccount_balances ?? []) {
    if (Number(shard.subaccount_number) !== ours) continue;
    cashByPartition[String(shard.exchange_index)] = scaleDecimal(shard.balance, PRICE_SCALE);
  }
  return {
    cashTotal: cash,
    cashAvailable: cash,
    cashByPartition,
    rebalanceTargets,
    portfolioValue,
    redeemableValue: 0n,
    positions,
    settlements,
    raw: { balance, subaccountBalances, ...(settlementsError ? { settlementsError } : {}) },
  };
}

// value is what a YES contract paid, in cents; a voided market pays back cost instead, which is left to the
// classifier. A market's settlement is the same for every account, so the login's own list serves any subaccount.
export function parseKalshiSettlement(s: Record<string, any>): VenueSettlement | null {
  if (!['yes', 'no', 'scalar'].includes(String(s.market_result)) || typeof s.value !== 'number') return null;
  const settledAt = new Date(s.settled_time);
  if (typeof s.ticker !== 'string' || Number.isNaN(settledAt.getTime())) return null;
  return { venueKey: s.ticker, settledAt, price: BigInt(s.value) * CENT };
}

// The endpoint's default page size.
const SETTLEMENT_PAGE_LIMIT = 100;

async function readKalshiSettlements(baseUrl: string, credentials: Credentials): Promise<VenueSettlement[]> {
  const minTs = Math.floor((Date.now() - SETTLEMENT_LOOKBACK_MS) / 1000);
  return (await pages(baseUrl, credentials,
    `/trade-api/v2/portfolio/settlements?limit=${SETTLEMENT_PAGE_LIMIT}&min_ts=${minTs}`, 'settlements'))
    .map(parseKalshiSettlement).filter((s): s is VenueSettlement => s !== null);
}

// Kalshi doesn't document its credit types, so they're matched by name until real payouts show what they are; a
// type matching none is booked unclassified. A credit's reason may name the market it paid for.
const CREDIT_PROGRAMS: [RegExp, CreditKind, CreditProgram][] = [
  [/interest|apy/i, 'INTEREST', 'INTEREST'],
  [/liquidity|\blip\b/i, 'REWARD', 'LIQUIDITY'],
  [/volume/i, 'REWARD', 'VOLUME'],
  [/referral/i, 'REWARD', 'REFERRAL'],
];
// A market ticker, or an event's (one dash fewer), whose markets all start with it.
const TICKER = /\bKX[A-Z0-9]+(?:-[A-Z0-9.]+)+\b/;
const MOVE_PAGE_LIMIT = 500;
const MAX_PAGES = 20;

export function parseKalshiCredit(c: Record<string, any>): VenueCredit | null {
  if (c.status !== 'applied') return null;
  const externalRef = `kalshi:credit:${c.credit_id}`;
  const amount = scaleDecimal(c.amount_dollars, PRICE_SCALE);
  const occurredAt = new Date(c.created_time);
  const venueType = c.reason ? `${c.type}: ${c.reason}` : String(c.type);
  const venueMarket = String(c.reason ?? '').match(TICKER)?.[0] ?? null;
  const match = CREDIT_PROGRAMS.find(([pattern]) => pattern.test(String(c.type)));
  if (!match || amount < 0n) return unclassifiedCredit(externalRef, amount, occurredAt, venueType, c, venueMarket);
  return { externalRef, kind: match[1], program: match[2], amount, occurredAt, venueMarket, venueType, raw: c };
}

// A deposit is in the balance once applied and a withdrawal out of it; returned undoes either. The fee is booked on
// its own, as a fee adjustment.
export function parseKalshiMove(row: Record<string, any>, kind: 'DEPOSIT' | 'WITHDRAWAL'): VenueCredit[] {
  if (row.status !== 'applied' && row.status !== 'returned') return [];
  const externalRef = `kalshi:${kind === 'DEPOSIT' ? 'dep' : 'wd'}:${row.id}`;
  const amount = (kind === 'DEPOSIT' ? 1n : -1n) * BigInt(row.amount_cents) * CENT;
  const occurredAt = new Date(Number(row.finalized_ts ?? row.created_ts) * 1000);
  const venueType = `${kind.toLowerCase()} (${row.type})`;
  const base = { program: null, occurredAt, venueMarket: null, raw: row };
  const credits: VenueCredit[] = [{ ...base, externalRef, kind, amount, venueType }];
  const fee = BigInt(row.fee_cents ?? 0) * CENT;
  if (fee !== 0n) {
    credits.push({ ...base, externalRef: `${externalRef}:fee`, kind: 'FEE_ADJUSTMENT', amount: -fee, venueType: `${venueType} fee` });
  }
  if (row.status === 'returned') {
    credits.push({
      ...base, externalRef: `${externalRef}:reversal`, kind: 'CORRECTION', amount: -amount, venueType: `${venueType} returned`,
      reverses: externalRef,
    });
  }
  return credits;
}

async function pages(baseUrl: string, credentials: Credentials, path: string, field: string): Promise<Record<string, any>[]> {
  const rows: Record<string, any>[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await get(baseUrl, credentials, `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    rows.push(...(body[field] ?? []));
    cursor = body.cursor ?? '';
    if (!cursor) break;
  }
  return rows;
}

// Credits, deposits and withdrawals belong to the whole Kalshi login, not one subaccount, and the API can't tell them
// apart; they're read for the main account only, or every subaccount registered on the login would book them again.
export async function readKalshiCredits(target: PollTarget, credentials: Credentials, since: Date): Promise<VenueCredit[]> {
  if (Number(target.venue_ref.subaccount ?? 0) !== 0) return [];
  const baseUrl = (process.env.KALSHI_API_URL ?? 'https://external-api.kalshi.com').replace(/\/$/, '');
  const minTs = Math.floor(since.getTime() / 1000);
  const credits = (await pages(baseUrl, credentials,
    `/trade-api/v2/portfolio/credit_history?limit=${PAGE_LIMIT}&min_ts=${minTs}`, 'credits'))
    .map(parseKalshiCredit).filter((c): c is VenueCredit => c !== null);
  const deposits = await pages(baseUrl, credentials, `/trade-api/v2/portfolio/deposits?limit=${MOVE_PAGE_LIMIT}`, 'deposits');
  const withdrawals = await pages(baseUrl, credentials,
    `/trade-api/v2/portfolio/withdrawals?limit=${MOVE_PAGE_LIMIT}`, 'withdrawals');
  const moves = [
    ...deposits.flatMap(d => parseKalshiMove(d, 'DEPOSIT')),
    ...withdrawals.flatMap(w => parseKalshiMove(w, 'WITHDRAWAL')),
  ].filter(m => m.occurredAt >= since);
  return [...credits, ...moves];
}

// Kalshi's incentive programs are public. Each run reads the programs not yet paid (active, upcoming, and closed: ended
// and awaiting payout); a paid program leaves the closed list, so its payout is seen by a separate sweep of the paid
// ones. Pages come roughly newest first by start, not strictly, so a sweep stops only after a whole page started
// before its cutoff.
const INCENTIVES_PATH = '/trade-api/v2/incentive_programs';
const INCENTIVE_PAGE_LIMIT = 1000;
const MAX_INCENTIVE_PAGES = 1000;
const CENTI_CENTS_PER_DOLLAR = 10_000;

export const UNPAID_INCENTIVE_STATUSES = ['active', 'upcoming', 'closed'];

function kalshiPublicUrl(): string {
  return (process.env.KALSHI_API_URL ?? 'https://external-api.kalshi.com').replace(/\/$/, '');
}

// period_reward is in hundredths of a cent; target_size_fp a decimal string of contracts.
export function parseKalshiIncentiveProgram(p: Record<string, any>): IncentiveProgramReading | null {
  if (p.incentive_type !== 'liquidity') return null;
  const reward = Number(p.period_reward);
  if (!Number.isInteger(reward) || reward < 0) throw new Error(`Kalshi program ${p.id} has period_reward ${p.period_reward}`);
  return {
    venueProgramId: String(p.id),
    program: 'LIQUIDITY',
    venueMarket: String(p.market_ticker),
    periodStart: new Date(p.start_date).toISOString(),
    periodEnd: new Date(p.end_date).toISOString(),
    reward: `${Math.floor(reward / CENTI_CENTS_PER_DOLLAR)}.${String(reward % CENTI_CENTS_PER_DOLLAR).padStart(4, '0')}`,
    rewardPer: 'PERIOD',
    definition: { targetSize: Number(p.target_size_fp), discountFactor: Number(p.discount_factor_bps) / 10_000 },
    paidOut: typeof p.paid_out === 'boolean' ? p.paid_out : null,
    sourceRef: INCENTIVES_PATH,
    raw: p,
  };
}

// Every program of a status, or, given a cutoff, until a whole page of programs started before it.
export async function readKalshiIncentivePages(status: string, startedAfter?: Date): Promise<Record<string, any>[]> {
  const rows: Record<string, any>[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_INCENTIVE_PAGES; page++) {
    const path = `${INCENTIVES_PATH}?status=${status}&limit=${INCENTIVE_PAGE_LIMIT}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await fetchWithRetry(`${kalshiPublicUrl()}${path}`);
    if (!res.ok) throw new Error(`Kalshi GET ${INCENTIVES_PATH} ${status} failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { incentive_programs?: Record<string, any>[]; next_cursor?: string };
    const programs = body.incentive_programs ?? [];
    rows.push(...programs);
    cursor = body.next_cursor ?? '';
    if (!cursor || programs.length === 0) return rows;
    if (startedAfter && programs.every(p => Date.parse(p.start_date) < startedAfter.getTime())) return rows;
  }
  throw new Error(`Kalshi ${status} incentive programs ran past ${MAX_INCENTIVE_PAGES} pages`);
}

export async function readKalshiIncentivePrograms(paidSince?: Date): Promise<IncentiveProgramReading[]> {
  // A sweep can hold hundreds of thousands of programs, past the argument count push(...rows) can spread.
  let rows: Record<string, any>[] = [];
  for (const status of UNPAID_INCENTIVE_STATUSES) rows = rows.concat(await readKalshiIncentivePages(status));
  if (paidSince) rows = rows.concat(await readKalshiIncentivePages('paid_out', paidSince));
  return rows.map(parseKalshiIncentiveProgram).filter((p): p is IncentiveProgramReading => p !== null);
}

// ----- listing specs -----

// Every Kalshi listing trades in hundredths of a contract, with no minimum beyond a lot.
const KALSHI_LOT_SIZE = 10_000;
const MARKETS_PATH = '/trade-api/v2/markets';
const HISTORICAL_MARKETS_PATH = '/trade-api/v2/historical/markets';
// Tickers per request: 400 is past the URL length Kalshi accepts.
const TICKERS_PER_REQUEST = 200;
const PAUSE_BETWEEN_REQUESTS_MS = 250;

/** A market's grid from its price_ranges ({start, end, step} dollar strings), the source of truth for its ticks. */
export function kalshiPriceBands(market: Record<string, any>): PriceBand[] | null {
  const ranges = market.price_ranges;
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const bands = ranges.map((r: Record<string, unknown>) => ({
    start: units(r.start, SPEC_PRICE_SCALE),
    end: units(r.end, SPEC_PRICE_SCALE),
    step: units(r.step, SPEC_PRICE_SCALE),
  }));
  if (bands.some(b => b.start === null || b.end === null || b.step === null || b.step <= 0)) return null;
  return bands.sort((a, b) => a.start! - b.start!) as PriceBand[];
}

/** The market ticker a listing trades, and whether the listing prices its complement (its NO side). */
export function kalshiMarketOf(exchangeSecurityId: string): { ticker: string; complement: boolean } {
  const colon = exchangeSecurityId.indexOf(':');
  if (colon < 0) return { ticker: exchangeSecurityId, complement: false };
  return { ticker: exchangeSecurityId.slice(0, colon), complement: exchangeSecurityId.slice(colon + 1).toLowerCase() === 'no' };
}

async function kalshiMarkets(path: string, tickers: string[]): Promise<Record<string, any>[]> {
  const url = `${kalshiPublicUrl()}${path}?limit=1000&tickers=${tickers.map(encodeURIComponent).join(',')}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`Kalshi GET ${path} failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { markets?: Record<string, any>[] }).markets ?? [];
}

/**
 * Specs for Kalshi listings: each market's price_ranges, mirrored for its NO listing. A market settled before Kalshi's
 * historical cutoff is only under /historical/markets, so tickers the live endpoint doesn't return are asked there,
 * unless only listed markets are wanted.
 */
export async function readKalshiSpecs(exchangeSecurityIds: string[], options: ReadOptions = {}): Promise<Map<string, VenueSpec>> {
  const listingsByTicker = new Map<string, string[]>();
  for (const id of exchangeSecurityIds) {
    const { ticker } = kalshiMarketOf(id);
    listingsByTicker.set(ticker, [...(listingsByTicker.get(ticker) ?? []), id]);
  }
  const bandsByTicker = new Map<string, PriceBand[]>();
  for (const path of options.listedOnly ? [MARKETS_PATH] : [MARKETS_PATH, HISTORICAL_MARKETS_PATH]) {
    const wanted = [...listingsByTicker.keys()].filter(t => !bandsByTicker.has(t));
    for (const batch of chunks(wanted, TICKERS_PER_REQUEST)) {
      for (const market of await kalshiMarkets(path, batch)) {
        const bands = kalshiPriceBands(market);
        if (bands) bandsByTicker.set(String(market.ticker), bands);
        else console.warn(`Kalshi market ${market.ticker} has no usable price_ranges: ${JSON.stringify(market.price_ranges)}`);
      }
      await pause(PAUSE_BETWEEN_REQUESTS_MS);
    }
  }
  const specs = new Map<string, VenueSpec>();
  for (const [ticker, ids] of listingsByTicker) {
    const bands = bandsByTicker.get(ticker);
    if (!bands) continue;
    for (const id of ids) specs.set(id, kalshiSpec(bands, kalshiMarketOf(id).complement));
  }
  return specs;
}

function kalshiSpec(bands: PriceBand[], complement: boolean): VenueSpec {
  return {
    priceBands: complement ? complementBands(bands) : bands,
    lotSize: KALSHI_LOT_SIZE,
    minNotional: 0,
    minSize: 0,
    contractMultiplier: SPEC_PRICE_SCALE,
  };
}

// Kalshi pages a metadata-updated read 1000 at a time; a day of changes is a few pages.
const CHANGED_PAGE = 1000;
const MAX_CHANGED_PAGES = 50;

/**
 * Specs of the Kalshi markets whose metadata changed since `since`, under every key a listing of them may have:
 * `min_updated_ts` tracks non-trading changes only, so this reads a few hundred markets where a full read reads every
 * open one. It can only be combined with `mve_filter=exclude`, so multivariate markets are never in it.
 */
export async function readKalshiChangedSpecs(since: Date): Promise<Map<string, VenueSpec>> {
  const specs = new Map<string, VenueSpec>();
  let cursor = '';
  for (let page = 0; page < MAX_CHANGED_PAGES; page++) {
    const query = `min_updated_ts=${Math.floor(since.getTime() / 1000)}&mve_filter=exclude&limit=${CHANGED_PAGE}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await fetchWithRetry(`${kalshiPublicUrl()}${MARKETS_PATH}?${query}`);
    if (!res.ok) throw new Error(`Kalshi GET ${MARKETS_PATH} (changed since) failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { markets?: Record<string, any>[]; cursor?: string };
    for (const market of body.markets ?? []) {
      const bands = kalshiPriceBands(market);
      if (!bands) continue;
      // A YES listing is keyed by the bare ticker or ticker:yes (kalshiMarketOf reads both); NO by ticker:no.
      for (const id of [market.ticker, `${market.ticker}:yes`, `${market.ticker}:no`]) {
        specs.set(id, kalshiSpec(bands, kalshiMarketOf(id).complement));
      }
    }
    cursor = body.cursor ?? '';
    if (!cursor) return specs;
    await pause(PAUSE_BETWEEN_REQUESTS_MS);
  }
  throw new Error(`Kalshi changed-since read ran past ${MAX_CHANGED_PAGES} pages`);
}

// ----- fee schedules -----

const SERIES_PATH = '/trade-api/v2/series';
const SERIES_FEE_CHANGES_PATH = '/trade-api/v2/series/fee_changes';
const EVENT_FEE_CHANGES_PATH = '/trade-api/v2/events/fee_changes';
const SERIES_PAGE_LIMIT = 1000;
const MAX_SERIES_PAGES = 200;

const KALSHI_TAKER_RATE = 0.07;
const KALSHI_DEFAULT_FEE: KalshiFee = ['quadratic', 1];
// Maker fees as a share of the taker fee, by Kalshi's fee_type (GET /series). 'flat' series follow a fee table no
// definition expresses; none are listed today.
const KALSHI_MAKER_SHARE: Record<string, number> = {
  quadratic: 0,
  quadratic_with_maker_fees: 0.25,
  quadratic_with_combo_maker_fees: 0.5,
};
// Kalshi rounded every fee up to the cent until it began rounding balances to $0.0001 and carrying the overpayment
// across an order's fills (docs.kalshi.com/getting_started/fee_rounding). The date is its changelog's, not confirmed.
export const KALSHI_ACCUMULATOR_FROM = new Date('2026-03-03T00:00:00Z');
// Kalshi's series fee history starts in October 2025, but some series have charged maker fees since before it and have
// never changed. Kalshi moved maker fees to the 0.0175 curve on 2025-07-01, so that is as far back as their current fee
// is known to hold.
export const KALSHI_UNRECORDED_FEE_FROM = new Date('2025-07-01T00:00:00Z');
const CENT_ROUNDING: IFeeRounding = { mode: 'CEIL', increment: 0.01, scope: 'FILL' };
const ACCUMULATOR_ROUNDING: IFeeRounding = { mode: 'CEIL', increment: 0.0001, scope: 'ORDER_ACCUMULATOR' };

type KalshiFee = [feeType: string, multiplier: number];

/** A Kalshi series or event fee schedule in force from `at`, or null for a fee type no definition expresses. */
export function kalshiFeeDefinition(feeType: string, multiplier: number, at: Date): IFeeDefinition | null {
  const makerShare = KALSHI_MAKER_SHARE[feeType];
  if (makerShare === undefined) return null;
  const taker = feeRate(KALSHI_TAKER_RATE * multiplier);
  return {
    currency: 'USD',
    components: [{ kind: 'PRICE_CURVE', taker, maker: feeRate(taker * makerShare), exponent: 1 }],
    rounding: { ...(at.getTime() >= KALSHI_ACCUMULATOR_FROM.getTime() ? ACCUMULATOR_ROUNDING : CENT_ROUNDING) },
  };
}

interface Priced extends VenueFeeSchedule {
  fee?: KalshiFee;
}

// For a target whose schedule from before the rounding cutover is still in force at it, the same rates under the new
// rounding from the cutover. `rows` are this target's, in effective order.
function withRoundingCutover(rows: Priced[]): Priced[] {
  const cutover = KALSHI_ACCUMULATOR_FROM.getTime();
  const before = rows.filter(r => Date.parse(r.effectiveFrom) < cutover);
  if (before.length === 0 || rows.some(r => Date.parse(r.effectiveFrom) === cutover)) return rows;
  const inForce = before[before.length - 1];
  if (inForce.definition === null || !inForce.fee) return rows;
  const definition = kalshiFeeDefinition(inForce.fee[0], inForce.fee[1], KALSHI_ACCUMULATOR_FROM);
  if (definition === null) return rows;
  const { fee: _fee, ...scope } = inForce;
  return byEffectiveFrom([...rows, {
    ...scope, effectiveFrom: KALSHI_ACCUMULATOR_FROM.toISOString(), definition, sourceRef: `${inForce.sourceRef}:accumulator`,
  }]);
}

// A fee type no definition expresses, recorded with no definition so the target falls through to the next scope (as if
// Kalshi had set nothing) and the registry's fee monitoring flags it by its source_ref.
function unsupported(row: Omit<VenueFeeSchedule, 'definition'>, feeType: string): Priced {
  return { ...row, definition: null, sourceRef: `${row.sourceRef}:unsupported:${feeType}` };
}

function seriesFee(series: Record<string, any>): KalshiFee {
  const { fee_type: feeType, fee_multiplier: multiplier } = series;
  if (feeType == null || multiplier == null) return KALSHI_DEFAULT_FEE;
  return [String(feeType), Number(multiplier)];
}

const isDefault = ([feeType, multiplier]: KalshiFee) =>
  feeType === KALSHI_DEFAULT_FEE[0] && multiplier === KALSHI_DEFAULT_FEE[1];

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

const byScheduled = (changes: Record<string, any>[]) =>
  [...changes].sort((a, b) => Date.parse(a.scheduled_ts) - Date.parse(b.scheduled_ts));

/**
 * Fee schedules from Kalshi's series (GET /series), their recorded fee changes (GET /series/fee_changes with history)
 * and event overrides (GET /events/fee_changes), each keyed by the change's id. A series charging other than the
 * default with no recorded change holds its fee from KALSHI_UNRECORDED_FEE_FROM.
 *
 * An event override replaces its series' fee type, multiplier or both; one with neither lifts the override (a null
 * definition). The part an override leaves out is taken from the series as it stood when the override began.
 */
export function kalshiFeeSchedules(
  series: Record<string, any>[], seriesChanges: Record<string, any>[], eventChanges: Record<string, any>[],
): VenueFeeSchedule[] {
  const recorded = new Set(seriesChanges.map(c => c.series_ticker));
  const allSeriesChanges = [
    ...seriesChanges,
    ...series.filter(s => s.ticker && !recorded.has(s.ticker) && !isDefault(seriesFee(s))).map(s => ({
      series_ticker: s.ticker, fee_type: seriesFee(s)[0], fee_multiplier: seriesFee(s)[1],
      scheduled_ts: KALSHI_UNRECORDED_FEE_FROM.toISOString(), id: `unrecorded-${s.ticker}`,
    })),
  ];
  const bySeries = new Map([...groupBy(allSeriesChanges, c => c.series_ticker)].map(([k, v]) => [k, byScheduled(v)]));
  const seriesAt = (ticker: string, at: Date): KalshiFee => {
    let state: KalshiFee = [...KALSHI_DEFAULT_FEE];
    for (const c of bySeries.get(ticker) ?? []) {
      if (Date.parse(c.scheduled_ts) <= at.getTime()) state = [c.fee_type, Number(c.fee_multiplier)];
    }
    return state;
  };

  const schedules: Priced[] = [];
  for (const [ticker, changes] of bySeries) {
    const rows = changes.map((c): Priced => {
      const at = new Date(c.scheduled_ts);
      const row = { feeGroup: ticker, effectiveFrom: at.toISOString(), sourceRef: `kalshi:series_fee_change:${c.id}` };
      const fee: KalshiFee = [c.fee_type, Number(c.fee_multiplier)];
      const definition = kalshiFeeDefinition(fee[0], fee[1], at);
      if (definition === null) {
        console.warn(`Kalshi series ${ticker} has fee type ${fee[0]} from ${c.scheduled_ts}, which no schedule expresses`);
        return unsupported(row, fee[0]);
      }
      return { ...row, definition, fee };
    });
    schedules.push(...withRoundingCutover(rows));
  }

  for (const [event, changes] of groupBy(eventChanges, c => c.event_ticker)) {
    const rows = byScheduled(changes).map((c): Priced => {
      const at = new Date(c.scheduled_ts);
      const row = { feeEvent: event, effectiveFrom: at.toISOString(), sourceRef: `kalshi:event_fee_change:${c.id}` };
      const typeOverride = c.fee_type_override, multiplierOverride = c.fee_multiplier_override;
      if (typeOverride == null && multiplierOverride == null) return { ...row, definition: null };
      const [seriesType, seriesMultiplier] = seriesAt(c.series_ticker, at);
      const fee: KalshiFee = [typeOverride ?? seriesType, multiplierOverride != null ? Number(multiplierOverride) : seriesMultiplier];
      const definition = kalshiFeeDefinition(fee[0], fee[1], at);
      if (definition === null) {
        console.warn(`Kalshi event ${event} has fee type ${fee[0]} from ${c.scheduled_ts}, which no schedule expresses`);
        return unsupported(row, fee[0]);
      }
      return { ...row, definition, fee };
    });
    schedules.push(...withRoundingCutover(rows));
  }
  return schedules.map(({ fee: _fee, ...row }) => row);
}

async function kalshiPages(path: string, field: string): Promise<Record<string, any>[]> {
  let rows: Record<string, any>[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_SERIES_PAGES; page++) {
    const query = `limit=${SERIES_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetchWithRetry(`${kalshiPublicUrl()}${path}?${query}`);
    if (!res.ok) throw new Error(`Kalshi GET ${path} failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as Record<string, any>;
    const items: Record<string, any>[] = body[field] ?? [];
    rows = rows.concat(items);
    cursor = body.cursor ?? '';
    if (!cursor || items.length === 0) return rows;
  }
  throw new Error(`Kalshi ${path} ran past ${MAX_SERIES_PAGES} pages`);
}

/** Every fee schedule Kalshi's history gives, from its series, series fee changes and current event overrides. */
export async function readKalshiFeeSchedules(): Promise<VenueFeeRead> {
  const series = await kalshiPages(SERIES_PATH, 'series');
  const res = await fetchWithRetry(`${kalshiPublicUrl()}${SERIES_FEE_CHANGES_PATH}?show_historical=true`);
  if (!res.ok) throw new Error(`Kalshi GET ${SERIES_FEE_CHANGES_PATH} failed: ${res.status} ${await res.text()}`);
  const seriesChanges = ((await res.json()) as { series_fee_change_arr?: Record<string, any>[] }).series_fee_change_arr ?? [];
  // Kalshi lists only the overrides in force or scheduled; one lifted earlier is known only from the rows written then.
  const eventChanges = await kalshiPages(EVENT_FEE_CHANGES_PATH, 'event_fee_changes');
  // A fee type no definition expresses is recorded as unsupported and flagged by the fee monitoring, not unreadable.
  return { schedules: kalshiFeeSchedules(series, seriesChanges, eventChanges), unreadable: [] };
}
