import { fetchWithRetry } from './http';
import { polymarketUsHeaders, polymarketUsKey } from './signers';
import {
  CreditBreakdown, CreditKind, CreditProgram, DAY_MS, IncentiveProgramReading, isoDate, PendingCredit, PollTarget,
  PRICE_SCALE, scaleDecimal, SETTLEMENT_LOOKBACK_MS, SIZE_SCALE, unclassifiedCredit, VenueCredit, VenueReading,
  VenueSettlement,
} from './types';

// Polymarket US reports balances per currency, and positions as an object keyed by market slug, paged by cursor,
// each with a signed net position (a short is negative: selling a contract the account doesn't hold opens one). A
// short's sale proceeds land in currentBalance while the venue holds its $1 payout back as marginRequirement; that
// dollar is counted as spent, as Kalshi spends it when it books a short as a NO, so the account's cash is what is
// really its own and the two venues reconcile the same way.

interface Credentials {
  apiKey: string;
  secret: string;
}

const TOTAL_FIELDS = ['currentBalance', 'balance', 'total', 'totalBalance'];
const AVAILABLE_FIELDS = ['buyingPower', 'availableBalance', 'available'];

function pick(entry: Record<string, unknown>, fields: string[]): unknown {
  for (const field of fields) if (entry[field] !== undefined && entry[field] !== null) return entry[field];
  return undefined;
}

export function parseBalances(body: unknown): { total: bigint; available: bigint; margin: bigint } {
  const list = Array.isArray(body) ? body : (body as { balances?: unknown[] })?.balances ?? [];
  const entries = list as Record<string, unknown>[];
  const usd = entries.find(e => String(e.currency ?? e.asset ?? '').toUpperCase() === 'USD') ?? (entries.length === 1 ? entries[0] : undefined);
  if (entries.length === 0) return { total: 0n, available: 0n, margin: 0n };
  if (!usd) throw new Error('No USD balance in the Polymarket US response');
  const total = pick(usd, TOTAL_FIELDS);
  if (total === undefined) throw new Error(`Unrecognized Polymarket US balance fields: ${Object.keys(usd).join(', ')}`);
  const available = pick(usd, AVAILABLE_FIELDS) ?? total;
  return {
    total: scaleDecimal(total, PRICE_SCALE),
    available: scaleDecimal(available, PRICE_SCALE),
    margin: scaleDecimal(usd.marginRequirement ?? 0, PRICE_SCALE),
  };
}

async function get(baseUrl: string, credentials: Credentials, path: string): Promise<any> {
  const key = polymarketUsKey(credentials.secret);
  const res = await fetchWithRetry(`${baseUrl}${path}`, () => ({
    headers: polymarketUsHeaders(credentials.apiKey, key, 'GET', path, Date.now()),
  }));
  if (!res.ok) throw new Error(`Polymarket US GET ${path.split('?')[0]} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function parsePositions(page: { positions?: Record<string, Record<string, any>> }): NonNullable<VenueReading['positions']> {
  return Object.entries(page.positions ?? {}).map(([slug, p]) => ({
    venueKey: slug,
    quantity: scaleDecimal(p.netPositionDecimal ?? p.netPosition, SIZE_SCALE),
    redeemable: false,
    value: p.cashValue?.value === undefined ? null : scaleDecimal(p.cashValue.value, PRICE_SCALE),
  })).filter(p => p.quantity !== 0n);
}

export async function readPolymarketUs(target: PollTarget, credentials: Credentials): Promise<VenueReading> {
  const baseUrl = (process.env.POLYMARKET_US_API_URL ?? 'https://api.polymarket.us').replace(/\/$/, '');
  const balances = await get(baseUrl, credentials, '/v1/account/balances');
  const { total, available, margin } = parseBalances(balances);
  const pages: unknown[] = [];
  const positions: NonNullable<VenueReading['positions']> = [];
  let portfolioValue = 0n;
  let cursor = '';
  do {
    const page = await get(baseUrl, credentials,
      `/v1/portfolio/positions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    pages.push(page);
    positions.push(...parsePositions(page));
    for (const p of Object.values(page.positions ?? {}) as Record<string, any>[]) {
      if (p.cashValue?.value !== undefined) portfolioValue += scaleDecimal(p.cashValue.value, PRICE_SCALE);
    }
    cursor = page.eof === false ? page.nextCursor ?? '' : '';
  } while (cursor);
  // Without them recon only waits for the classifier, as it always could; that's no reason to lose the reading.
  let settlementsError: string | undefined;
  const settlements = await readPolymarketUsSettlements(baseUrl, credentials).catch((error: unknown) => {
    settlementsError = error instanceof Error ? error.message : String(error);
    console.error(`Reading ${target.label} settlements failed: ${settlementsError}`);
    return undefined;
  });
  return {
    cashTotal: total - margin, cashAvailable: available, portfolioValue, redeemableValue: 0n, positions, settlements,
    raw: { balances, positions: pages, account: target.label, ...(settlementsError ? { settlementsError } : {}) },
  };
}

const RESOLUTION_TYPE = 'ACTIVITY_TYPE_POSITION_RESOLUTION';

// Polymarket US closes an account's position when its market resolves, as an activity naming the market and the
// price each side settled at (a tie pays both 0.50). The long side's price is the market's.
export function parsePolymarketUsResolution(activity: Record<string, any>): VenueSettlement | null {
  const resolution = activity.positionResolution;
  if (activity.type !== RESOLUTION_TYPE || !resolution) return null;
  const long = (resolution.market?.marketSides ?? []).find((side: Record<string, any>) => side.long === true);
  const settledAt = new Date(resolution.updateTime);
  if (typeof resolution.marketSlug !== 'string' || long?.price == null || Number.isNaN(settledAt.getTime())) return null;
  return { venueKey: resolution.marketSlug, settledAt, price: scaleDecimal(long.price, PRICE_SCALE) };
}

// The feed comes newest first; reading stops at the first page reaching back past the lookback.
async function readPolymarketUsSettlements(baseUrl: string, credentials: Credentials): Promise<VenueSettlement[]> {
  const since = Date.now() - SETTLEMENT_LOOKBACK_MS;
  const settlements: VenueSettlement[] = [];
  let cursor = '';
  for (;;) {
    const page = await get(baseUrl, credentials,
      `/v1/portfolio/activities?limit=100&types=${RESOLUTION_TYPE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const read = ((page.activities ?? []) as Record<string, any>[]).map(parsePolymarketUsResolution)
      .filter((s): s is VenueSettlement => s !== null);
    settlements.push(...read.filter(s => s.settledAt.getTime() >= since));
    cursor = page.eof === false ? page.nextCursor ?? '' : '';
    if (!cursor || read.some(s => s.settledAt.getTime() < since)) break;
  }
  return settlements;
}

// Money Polymarket US moves on the account outside trading, from its activity feed. Rewards and rebates count once
// COMPLETED. Its weekly taker rebate has so far come as a plain TRANSFER with no reason, on a Friday, rather than as a
// TAKER_FEE_REBATE; only a small reasonless transfer in on a Friday is taken for one, and any other transfer in is
// booked unclassified.
const COMPLETED = 'ACCOUNT_BALANCE_CHANGE_STATUS_COMPLETED';
const REJECTED = 'ACCOUNT_BALANCE_CHANGE_STATUS_REJECTED';
const PARTIALLY_REFUNDED = 'ACCOUNT_BALANCE_CHANGE_STATUS_PARTIALLY_REFUNDED';
const UNSPECIFIED_REASON = 'TRANSFER_REASON_UNSPECIFIED';
const REBATE_DAY = 5;
const MAX_UNLABELLED_REBATE = 500n * PRICE_SCALE;
const REWARD_TYPES: Record<string, [CreditKind, CreditProgram]> = {
  ACTIVITY_TYPE_LIQUIDITY_PROGRAM: ['REWARD', 'LIQUIDITY'],
  ACTIVITY_TYPE_TAKER_FEE_REBATE: ['REWARD', 'TAKER_REBATE'],
  ACTIVITY_TYPE_REFERRAL_BONUS: ['REWARD', 'REFERRAL'],
};
const DEPOSIT_TYPES = ['ACTIVITY_TYPE_ACCOUNT_DEPOSIT', 'ACTIVITY_TYPE_ACCOUNT_ADVANCED_DEPOSIT'];
const WITHDRAWAL_TYPE = 'ACTIVITY_TYPE_ACCOUNT_WITHDRAWAL';
const TRANSFER_TYPE = 'ACTIVITY_TYPE_TRANSFER';
export const POLYMARKET_US_CREDIT_TYPES = [...Object.keys(REWARD_TYPES), ...DEPOSIT_TYPES, WITHDRAWAL_TYPE, TRANSFER_TYPE];

const money = (amount: { value?: string } | null | undefined): bigint =>
  amount?.value === undefined ? 0n : scaleDecimal(amount.value, PRICE_SCALE);

const present = (c: VenueCredit | null): c is VenueCredit => c !== null;

// A deposit can be advanced: the venue puts the money in the balance when it's made, days before the payment clears.
// The advance is booked when it was made and the rest when the deposit completes. A withdrawal leaves the balance as
// soon as it's asked for. A rejected deposit or withdrawal is undone. A partial refund says nothing of how much came
// back, so it's flagged at $0 for a person, and recon shows the difference.
export function parsePolymarketUsActivity(activity: Record<string, any>): VenueCredit[] {
  const change = activity.accountBalanceChange;
  if (!change) return [];
  const type = String(activity.type);
  const externalRef = `pmus:${change.transactionId}`;
  const status = String(change.status);
  const amount = money(change.amount);
  const created = new Date(change.createTime);
  const updated = new Date(change.updateTime ?? change.createTime);
  const base = { program: null, venueMarket: null, raw: activity };
  const reversal = (booked: bigint): VenueCredit => ({
    ...base, externalRef: `${externalRef}:reversal`, kind: 'CORRECTION', amount: -booked, occurredAt: updated,
    venueType: `${type} rejected`, reverses: externalRef,
  });
  const refundFlag = () => unclassifiedCredit(`${externalRef}:partial-refund`, 0n, updated,
    `${type} partly refunded; the refund isn't booked`, activity);

  if (DEPOSIT_TYPES.includes(type)) {
    const advanced = (change.transactions ?? []).reduce(
      (sum: bigint, t: Record<string, any>) => sum + money(t.advancedAmount), 0n) as bigint;
    const credits: (VenueCredit | null)[] = [];
    if (advanced > 0n) {
      credits.push({ ...base, externalRef, kind: 'DEPOSIT', amount: advanced, occurredAt: created, venueType: type });
      if (status === COMPLETED && amount > advanced) {
        credits.push({
          ...base, externalRef: `${externalRef}:rest`, kind: 'DEPOSIT', amount: amount - advanced, occurredAt: updated,
          venueType: type,
        });
      }
      if (status === REJECTED) credits.push(reversal(advanced));
    } else if (status === COMPLETED || status === PARTIALLY_REFUNDED) {
      credits.push({ ...base, externalRef, kind: 'DEPOSIT', amount, occurredAt: updated, venueType: type });
    }
    if (status === PARTIALLY_REFUNDED) credits.push(refundFlag());
    return credits.filter(present);
  }
  if (type === WITHDRAWAL_TYPE) {
    const out = amount < 0n ? amount : -amount;
    const credits: (VenueCredit | null)[] = [
      { ...base, externalRef, kind: 'WITHDRAWAL', amount: out, occurredAt: created, venueType: type },
    ];
    if (status === REJECTED) credits.push(reversal(out));
    if (status === PARTIALLY_REFUNDED) credits.push(refundFlag());
    return credits.filter(present);
  }
  if (status !== COMPLETED) return [];
  const reward = REWARD_TYPES[type];
  if (reward && amount >= 0n) {
    return [{ ...base, externalRef, kind: reward[0], program: reward[1], amount, occurredAt: created, venueType: type }];
  }
  const reasonless = (change.transferReason ?? UNSPECIFIED_REASON) === UNSPECIFIED_REASON;
  if (type === TRANSFER_TYPE && reasonless && amount > 0n && amount <= MAX_UNLABELLED_REBATE
    && created.getUTCDay() === REBATE_DAY) {
    return [{
      ...base, externalRef, kind: 'REWARD', program: 'TAKER_REBATE', amount, occurredAt: created,
      venueType: `${type} (weekly taker rebate)`,
    }];
  }
  const reason = change.transferReason ? `${type} ${change.transferReason}` : type;
  return [unclassifiedCredit(externalRef, amount, created, reason, activity)].filter(present);
}

// The feed comes newest first; reading stops at the first page wholly older than `since`, by when each row was last
// updated too, so a deposit created days before it completed is still read.
export async function readPolymarketUsCredits(credentials: Credentials, since: Date): Promise<VenueCredit[]> {
  const baseUrl = (process.env.POLYMARKET_US_API_URL ?? 'https://api.polymarket.us').replace(/\/$/, '');
  const types = POLYMARKET_US_CREDIT_TYPES.map(t => `types=${t}`).join('&');
  const credits: VenueCredit[] = [];
  let cursor = '';
  for (;;) {
    const page = await get(baseUrl, credentials,
      `/v1/portfolio/activities?limit=100&${types}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const activities: Record<string, any>[] = page.activities ?? [];
    credits.push(...activities.flatMap(parsePolymarketUsActivity));
    const newest = activities.map(a => Math.max(
      new Date(a.accountBalanceChange?.createTime ?? 0).getTime(),
      new Date(a.accountBalanceChange?.updateTime ?? 0).getTime()))
      .reduce((max, t) => Math.max(max, t), 0);
    cursor = page.eof === false ? page.nextCursor ?? '' : '';
    if (!cursor || newest < since.getTime()) break;
  }
  return credits.filter(c => c.occurredAt >= since);
}

const EARNINGS_LOOKBACK_DAYS = 30;
const VENUE_ZONE = 'America/New_York';

const earned = (reward: unknown): bigint => {
  const value = typeof reward === 'object' && reward !== null ? (reward as { value?: unknown }).value : reward;
  return scaleDecimal(value ?? 0, PRICE_SCALE);
};

// Midnight starting a calendar day in the venue's zone (US Eastern), whose offset from UTC changes with daylight saving.
export function easternMidnight(date: string): Date {
  // Noon UTC falls on the same Eastern date whatever the offset.
  return easternDayStart(new Date(`${date.slice(0, 10)}T12:00:00Z`));
}

// Everything each market earned per (Eastern) day up to the payout, for the registry to find the oldest unpaid days
// the payout covers: the venue pays days a week or so late, in arrears.
export function liquidityBreakdown(
  credit: PendingCredit, rewards: { reward?: unknown; marketSlug?: string; date?: string }[],
): CreditBreakdown {
  const paid = new Date(credit.occurred_at);
  const markets = rewards
    .filter(r => r.marketSlug && r.date)
    .map(r => {
      const from = easternMidnight(String(r.date));
      const to = easternMidnight(new Date(from.getTime() + 36 * 3_600_000).toISOString());
      return { venueMarket: String(r.marketSlug), amount: earned(r.reward), from, to, periodStart: from, periodEnd: to };
    })
    .filter(m => m.amount > 0n && m.to <= paid)
    .sort((a, b) => a.from.getTime() - b.from.getTime());
  return { externalRef: credit.external_ref, markets, inArrears: true };
}

export async function readPolymarketUsBreakdowns(credentials: Credentials, pending: PendingCredit[]): Promise<CreditBreakdown[]> {
  const baseUrl = (process.env.POLYMARKET_US_API_URL ?? 'https://api.polymarket.us').replace(/\/$/, '');
  const breakdowns: CreditBreakdown[] = [];
  for (const credit of pending.filter(c => c.program === 'LIQUIDITY')) {
    const paid = new Date(credit.occurred_at);
    const start = new Date(paid.getTime() - EARNINGS_LOOKBACK_DAYS * DAY_MS);
    const page = await get(baseUrl, credentials, `/v1/incentives/earnings?start_date=${isoDate(start)}`
      + `&end_date=${isoDate(paid)}&program_type=liquidityProgram`);
    breakdowns.push(liquidityBreakdown(credit, page.rewards ?? []));
  }
  return breakdowns;
}

// Polymarket US's liquidity programs, from the gateway's public list (api.polymarket.us serves the same list only to a
// signed request). A reading is one period of a venue program on one market: many markets share a programId, and a
// market can carry several. A programId's pool is one pool, split by score across every market carrying it
// (polymarket.us/rewards: "never summed per market"), so each reading's reward is that whole pool and its definition
// names the programId; summing rewards across markets counts a pool many times over.
// The list's `start` is when the venue program began across all its markets, not when a market's period opens: early,
// day_of and live run on the market's own kickoff (early from listing to six hours before it, day_of those six hours,
// live from it until the market stops trading); daily and daily_event pools pay per Eastern day. The list never gives
// an end, and a period's status follows its venue program rather than its window, so a market's programs are posted
// only while it trades; the sync ends them once it doesn't.
// The gateway ignores the documented pageSize and pageToken, serving the first page again with a fresh token forever;
// it reads page_size and page_token.
const INCENTIVES_URL = 'https://gateway.polymarket.us/v1/incentives';
const INCENTIVE_PAGE_SIZE = 500;
const MAX_INCENTIVE_PAGES = 400;
const TRADING = 'INSTRUMENT_STATE_OPEN';
const LISTED_STATUSES = ['active', 'pending'];
const DAY_PERIODS = ['daily', 'daily_event'];
const WINDOW_PERIODS = ['early', 'day_of', 'live'];
const PRE_GAME_MS = 6 * 3_600_000;

export interface PolymarketUsIncentiveRead {
  programs: IncentiveProgramReading[];
  // Markets the list shows but that no longer trade: stopped, or expired and not yet dropped from the list.
  stopped: Set<string>;
}

const easternDate = (at: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: VENUE_ZONE }).format(at);
const easternHour = (at: Date): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: VENUE_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(at));

// Midnight starting the Eastern day the instant falls on, exact on the days daylight saving changes.
export function easternDayStart(at: Date): Date {
  const date = easternDate(at);
  for (const behindUtc of [4, 5]) {
    const midnight = new Date(Date.parse(`${date}T00:00:00Z`) + behindUtc * 3_600_000);
    if (easternDate(midnight) === date && easternHour(midnight) === 0) return midnight;
  }
  throw new Error(`No Eastern midnight found for ${date}`);
}

export const nextEasternMidnight = (at: Date): Date =>
  easternDayStart(new Date(easternDayStart(at).getTime() + 25 * 3_600_000));

// The venue writes kickoffs three ways: "2026-11-19 00:00:00+00", "2026-11-10T05:00:00.000Z", "2026-10-16T12:00:00-04:00".
export function kickoffTime(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(ms) ? null : new Date(ms);
}

const later = (a: Date, b: Date): Date => (a > b ? a : b);

// Null for a window period on a market with no kickoff: its window can't be placed (all are markets already closed).
function programWindow(period: string, start: Date, kickoff: Date | null)
  : { from: Date; to: Date | null; per: 'DAY' | 'PERIOD' } | null {
  if (DAY_PERIODS.includes(period)) return { from: start, to: null, per: 'DAY' };
  if (!WINDOW_PERIODS.includes(period)) throw new Error(`Polymarket US program period ${period} has no known window`);
  if (!kickoff) return null;
  const preGame = new Date(kickoff.getTime() - PRE_GAME_MS);
  if (period === 'early') return { from: start, to: preGame, per: 'PERIOD' };
  if (period === 'day_of') return { from: later(start, preGame), to: kickoff, per: 'PERIOD' };
  return { from: later(start, kickoff), to: null, per: 'PERIOD' };
}

export function parsePolymarketUsIncentiveMarket(m: Record<string, any>): IncentiveProgramReading[] {
  if (m.instrumentState !== TRADING) return [];
  const { timePeriods, ...market } = m;
  const slug = String(m.marketSlug);
  const kickoff = kickoffTime(m.eventStartTime);
  return ((timePeriods ?? []) as Record<string, any>[]).flatMap((p): IncentiveProgramReading[] => {
    if (p.programType !== 'liquidityProgram' || !LISTED_STATUSES.includes(p.status)) return [];
    const window = programWindow(String(p.period), new Date(p.start), kickoff);
    if (!window) return [];
    const pool = Number(p.rewardPool);
    if (!Number.isFinite(pool) || pool < 0) throw new Error(`Polymarket US program ${p.programId} has rewardPool ${p.rewardPool}`);
    const end = p.end ? new Date(p.end) : window.to;
    return [{
      venueProgramId: `${p.programId}:${slug}:${p.period}`,
      program: 'LIQUIDITY',
      venueMarket: slug,
      periodStart: window.from.toISOString(),
      periodEnd: end ? end.toISOString() : null,
      reward: String(pool),
      rewardPer: window.per,
      definition: {
        targetSize: Number(p.targetSize),
        discountFactor: Number(p.discountFactor),
        // Dollars from the mid; 0.07 × 100 is 7.000000000000001 in floating point.
        ...(p.maxSpread != null ? { maxSpreadCents: Number((Number(p.maxSpread) * 100).toFixed(4)) } : {}),
        period: String(p.period),
        programId: String(p.programId),
      },
      paidOut: null,
      sourceRef: INCENTIVES_URL,
      raw: { ...market, timePeriod: p },
    }];
  });
}

// Every page, or an error: a partial list would read as programs ending. A page that brings no market not already
// read means the cursor isn't moving.
export async function readPolymarketUsIncentivePrograms(): Promise<PolymarketUsIncentiveRead> {
  const baseUrl = process.env.POLYMARKET_US_GATEWAY_URL ?? INCENTIVES_URL;
  const seen = new Set<string>();
  const stopped = new Set<string>();
  let programs: IncentiveProgramReading[] = [];
  let token = '';
  for (let page = 0; page < MAX_INCENTIVE_PAGES; page++) {
    const res = await fetchWithRetry(`${baseUrl}?page_size=${INCENTIVE_PAGE_SIZE}`
      + (token ? `&page_token=${encodeURIComponent(token)}` : ''));
    if (!res.ok) throw new Error(`Polymarket US incentives page ${page} failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { programs?: Record<string, any>[]; nextPageToken?: string };
    const markets = body.programs ?? [];
    const fresh = markets.filter(m => !seen.has(String(m.marketSlug)));
    if (markets.length > 0 && fresh.length === 0) throw new Error(`Polymarket US incentives page ${page} repeats markets already read`);
    for (const m of fresh) {
      seen.add(String(m.marketSlug));
      if (m.instrumentState !== TRADING) stopped.add(String(m.marketSlug));
    }
    programs = programs.concat(fresh.flatMap(parsePolymarketUsIncentiveMarket));
    token = body.nextPageToken ?? '';
    if (!token || markets.length === 0) return { programs, stopped };
  }
  throw new Error(`Polymarket US incentives ran past ${MAX_INCENTIVE_PAGES} pages`);
}

// The end of a program the registry holds as running that a read no longer posts. A daily pool covers the whole
// Eastern day, so one whose market stopped trading runs to the end of that day; one the venue dropped from a market
// still trading may not pay the part day, so it ends with the last whole one. A windowed program ends now: its market
// stopped trading or the venue dropped it, and nothing earns after either. An expired market leaves the list an hour
// or two after it stops; a sync down longer than that reads it as dropped.
export function polymarketUsUnlistedEnd(program: IncentiveProgramReading, now: Date, stopped: Set<string>): Date {
  if (program.rewardPer === 'PERIOD') return now;
  return stopped.has(program.venueMarket) ? nextEasternMidnight(now) : easternDayStart(now);
}
