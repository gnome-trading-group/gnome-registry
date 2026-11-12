import { fetchWithRetry } from './http';
import { kalshiHeaders } from './signers';
import {
  CreditKind, CreditProgram, PollTarget, PRICE_SCALE, RebalanceReading, RebalanceTargets, sameTargets, scaleDecimal,
  SIZE_SCALE, unclassifiedCredit, VenueCredit, VenueReading,
} from './types';
import { IncentiveProgramReading } from './types';

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
    raw: { balance, subaccountBalances },
  };
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
  const rows: Record<string, any>[] = [];
  for (const status of UNPAID_INCENTIVE_STATUSES) rows.push(...await readKalshiIncentivePages(status));
  if (paidSince) rows.push(...await readKalshiIncentivePages('paid_out', paidSince));
  return rows.map(parseKalshiIncentiveProgram).filter((p): p is IncentiveProgramReading => p !== null);
}
