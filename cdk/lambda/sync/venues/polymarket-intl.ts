import { fetchWithRetry } from './http';
import { polymarketIntlHeaders } from './signers';
import {
  BreakdownMarket, CreditBreakdown, CreditKind, CreditProgram, DAY_MS, isoDate, payoutDay, PendingCredit, PollTarget,
  PRICE_SCALE, scaleDecimal, SIZE_SCALE, VenueCredit, VenueReading,
} from './types';
import { IncentiveProgramReading } from './types';

// Polymarket Intl holds everything on chain, so an account is read with no credentials: its collateral is the
// funder wallet's pUSD balance on Polygon, its positions come from the public data API by that wallet's address.
// Resolved positions stay as tokens until redeemed, worth their payout.

const DATA_API = 'https://data-api.polymarket.com/v2';
const PAGE_LIMIT = 1000;
// The API drops holdings under 0.1 shares and positions on archived markets by default; recon must see every token
// the wallet still holds, or it reads a dust or archived holding as a position that vanished.
const POSITION_FILTERS = 'filter_type=TOKENS&filter_amount=0&include_archived=true';
// pUSD has 6 decimals; prices are in 1e9 per dollar.
const PUSD_TO_PRICE = PRICE_SCALE / 1_000_000n;
// Public Polygon RPCs refuse requests without a browser-like user agent.
const USER_AGENT = 'Mozilla/5.0 (compatible; gnome-venue-poller)';
const BALANCE_OF = '0x70a08231';

async function collateral(funder: string): Promise<bigint> {
  const rpc = process.env.POLYGON_RPC_URL;
  const token = process.env.PUSD_TOKEN_ADDRESS;
  if (!rpc || !token) throw new Error('POLYGON_RPC_URL and PUSD_TOKEN_ADDRESS must be set to read Polymarket Intl cash');
  const data = `${BALANCE_OF}${funder.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const res = await fetchWithRetry(rpc, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] }),
  }), async answer => !(await answer.json().catch(() => ({})) as { result?: string }).result);
  const body = await res.json() as { result?: string; error?: { message: string } };
  if (!res.ok || !body.result) throw new Error(`Polygon balanceOf failed: ${res.status} ${body.error?.message ?? ''}`);
  return BigInt(body.result) * PUSD_TO_PRICE;
}

export async function readPolymarketIntl(target: PollTarget): Promise<VenueReading> {
  const funder = target.venue_ref.funderAddress;
  if (typeof funder !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(funder)) {
    throw new Error(`Account ${target.label} has no funderAddress in its venue_ref`);
  }
  const cash = await collateral(funder);
  const positions: NonNullable<VenueReading['positions']> = [];
  const rows: unknown[] = [];
  let redeemableValue = 0n;
  let portfolioValue = 0n;
  // A cursor must travel with the same user anchor it was minted under; the API rejects a bare one.
  let cursor: string | null = null;
  do {
    const page: string = cursor === null
      ? `limit=${PAGE_LIMIT}&${POSITION_FILTERS}`
      : `cursor=${encodeURIComponent(cursor)}&${POSITION_FILTERS}`;
    const res = await fetchWithRetry(`${DATA_API}/positions?user=${funder}&${page}`,
      () => ({ headers: { 'User-Agent': USER_AGENT } }));
    if (!res.ok) throw new Error(`Polymarket positions failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as {
      data: { token_id: string; current_size: number; redeemable?: boolean; current_value?: number | null }[] | null;
      pagination: { next_cursor: string | null };
    };
    for (const p of body.data ?? []) {
      const value = p.current_value == null ? null : scaleDecimal(p.current_value, PRICE_SCALE);
      positions.push({
        venueKey: p.token_id, quantity: scaleDecimal(p.current_size, SIZE_SCALE), redeemable: p.redeemable === true, value,
      });
      if (value !== null) portfolioValue += value;
      if (p.redeemable === true && value !== null) redeemableValue += value;
    }
    rows.push(...(body.data ?? []));
    cursor = body.pagination.next_cursor;
  } while (cursor !== null);
  return {
    cashTotal: cash, cashAvailable: cash, portfolioValue, redeemableValue, positions, raw: { positions: rows },
  };
}

// What Polymarket pays a wallet on its own, and its deposits and withdrawals, as the public activity feed lists them.
// Payouts are each a day's total per program and name no market; they land a little after midnight UTC.
const CREDIT_TYPES: Record<string, [CreditKind, CreditProgram | null]> = {
  REWARD: ['REWARD', 'LIQUIDITY'],
  MAKER_REBATE: ['REWARD', 'MAKER_REBATE'],
  TAKER_REBATE: ['REWARD', 'TAKER_REBATE'],
  YIELD: ['REWARD', 'HOLDING'],
  REFERRAL_REWARD: ['REWARD', 'REFERRAL'],
  DEPOSIT: ['DEPOSIT', null],
  WITHDRAWAL: ['WITHDRAWAL', null],
};

// One transaction can pay a wallet the same type more than once, identical but for the amount (a taker rebate's
// level-up bonuses), even the same amount twice; such rows share a timestamp, so they come back together, and their
// order among themselves names them.
export function parsePolymarketIntlActivity(rows: Record<string, any>[]): VenueCredit[] {
  const seen = new Map<string, number>();
  const credits: VenueCredit[] = [];
  for (const row of rows) {
    const type = String(row.type);
    const mapped = CREDIT_TYPES[type];
    if (!mapped) continue;
    const size = scaleDecimal(row.usdc_size, PRICE_SCALE);
    const base = `pm:${type}:${row.transaction_hash}:${size}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    const [kind, program] = mapped;
    credits.push({
      externalRef: `${base}:${occurrence}`, kind, program, amount: kind === 'WITHDRAWAL' ? -size : size,
      occurredAt: new Date(Number(row.timestamp) * 1000), venueMarket: null, venueType: type, raw: row,
    });
  }
  return credits;
}

export async function readPolymarketIntlCredits(target: PollTarget, since: Date): Promise<VenueCredit[]> {
  const funder = target.venue_ref.funderAddress;
  if (typeof funder !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(funder)) {
    throw new Error(`Account ${target.label} has no funderAddress in its venue_ref`);
  }
  // Unlike positions, activity wants the user on every page, cursor or not.
  const filters = `user=${funder}&limit=${PAGE_LIMIT}&type=${Object.keys(CREDIT_TYPES).join(',')}`
    + `&exclude_deposits_withdrawals=false&start=${Math.floor(since.getTime() / 1000)}`;
  const rows: Record<string, any>[] = [];
  let cursor: string | null = null;
  do {
    const page = cursor === null ? filters : `${filters}&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetchWithRetry(`${DATA_API}/activity?${page}`, () => ({ headers: { 'User-Agent': USER_AGENT } }));
    if (!res.ok) throw new Error(`Polymarket activity failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { data: Record<string, any>[] | null; pagination?: { next_cursor: string | null } };
    rows.push(...(body.data ?? []));
    cursor = body.pagination?.next_cursor ?? null;
  } while (cursor !== null);
  return parsePolymarketIntlActivity(rows);
}

export interface ClobCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

const CLOB_API = 'https://clob.polymarket.com';
const LAST_CURSOR = 'LTE=';

// Rewards and rebates are a UTC day's, so the day is both the time they were earned over and the program's period.
function byCondition(rows: { condition: string; amount: bigint }[], day: Date): BreakdownMarket[] {
  const totals = new Map<string, bigint>();
  for (const r of rows) totals.set(r.condition, (totals.get(r.condition) ?? 0n) + r.amount);
  const to = new Date(day.getTime() + DAY_MS);
  return [...totals].filter(([, amount]) => amount > 0n)
    .map(([venueMarket, amount]) => ({ venueMarket, amount, from: day, to, periodStart: day, periodEnd: to }));
}

// A day's maker rebates per market, public, keyed by the wallet that made.
async function makerRebates(funder: string, day: Date): Promise<BreakdownMarket[]> {
  const res = await fetchWithRetry(`${CLOB_API}/rebates/current?date=${isoDate(day)}&maker_address=${funder}`,
    () => ({ headers: { 'User-Agent': USER_AGENT } }));
  if (!res.ok) throw new Error(`Polymarket rebates failed: ${res.status} ${await res.text()}`);
  const rows = (await res.json() ?? []) as { condition_id: string; rebated_fees_usdc: string }[];
  return byCondition(rows.map(r => ({ condition: r.condition_id, amount: scaleDecimal(r.rebated_fees_usdc, PRICE_SCALE) })), day);
}

// Earnings are in the reward's asset; its rate turns them into dollars.
function inDollars(earnings: unknown, rate: unknown): bigint {
  return (scaleDecimal(earnings, PRICE_SCALE) * scaleDecimal(rate ?? 1, PRICE_SCALE)) / PRICE_SCALE;
}

// A day's liquidity rewards per market, which only the wallet's own CLOB API key may read: the native ones, or the
// sponsored ones (sponsored=true).
async function liquidityRewards(
  target: PollTarget, credentials: ClobCredentials, day: Date, sponsored: boolean,
): Promise<{ condition: string; amount: bigint }[]> {
  const funder = String(target.venue_ref.funderAddress);
  const signer = String(target.venue_ref.signerAddress ?? '');
  const signatureType = String(target.venue_ref.signatureType ?? '');
  const rows: { condition: string; amount: bigint }[] = [];
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const path = `/rewards/user?date=${isoDate(day)}&maker_address=${funder}&signature_type=${signatureType}`
      + `&sponsored=${sponsored}` + (cursor ? `&next_cursor=${encodeURIComponent(cursor)}` : '');
    const res = await fetchWithRetry(`${CLOB_API}${path}`, () => ({
      headers: { ...polymarketIntlHeaders(credentials, signer, 'GET', path, Date.now()), 'User-Agent': USER_AGENT },
    }));
    if (!res.ok) throw new Error(`Polymarket rewards failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as {
      data?: { condition_id: string; earnings: number | string; asset_rate?: number | string }[]; next_cursor?: string;
    };
    rows.push(...(body.data ?? []).map(r => ({ condition: r.condition_id, amount: inDollars(r.earnings, r.asset_rate) })));
    cursor = body.next_cursor ?? '';
    if (!cursor || cursor === LAST_CURSOR) break;
  }
  return rows;
}

// Each pending payout's split by market, for the day it paid. Liquidity rewards need the wallet's CLOB API key, so
// without one they're left for when it's added.
export async function readPolymarketIntlBreakdowns(
  target: PollTarget, credentials: ClobCredentials | null, pending: PendingCredit[],
): Promise<CreditBreakdown[]> {
  const funder = target.venue_ref.funderAddress;
  if (typeof funder !== 'string') return [];
  const breakdowns: CreditBreakdown[] = [];
  for (const credit of pending) {
    const day = payoutDay(new Date(credit.occurred_at));
    if (credit.program === 'MAKER_REBATE') {
      breakdowns.push({ externalRef: credit.external_ref, markets: await makerRebates(funder, day) });
    } else if (credit.program === 'LIQUIDITY' && credentials) {
      // Whether the day's payout includes its sponsored rewards isn't documented: both readings are offered.
      const native = await liquidityRewards(target, credentials, day, false);
      const sponsored = await liquidityRewards(target, credentials, day, true);
      breakdowns.push({
        externalRef: credit.external_ref, markets: byCondition(native, day),
        alternatives: sponsored.length > 0 ? [byCondition([...native, ...sponsored], day)] : [],
      });
    }
  }
  return breakdowns;
}

// Polymarket's liquidity rewards, from the CLOB's public list of every market rewarded now: one program per reward
// config (a market can carry several, one per sponsor and asset), paid per UTC day. The list has no history and no
// config id, so a program is its market, asset and start date, and one that drops off the list has ended. Daily rates
// move by a dollar or so many times a day, each move a new version, so the venue's row isn't kept: the program's
// columns already hold all of it.
const REWARDS_URL = `${CLOB_API}/rewards/markets/current`;
const MAX_REWARD_PAGES = 200;
// Configs with no end carry this year.
const OPEN_ENDED_YEAR = 2500;

export function parsePolymarketIntlRewardMarket(m: Record<string, any>): IncentiveProgramReading[] {
  return (m.rewards_config ?? []).map((c: Record<string, any>) => {
    const end = new Date(`${c.end_date}T00:00:00Z`);
    return {
      venueProgramId: `${m.condition_id}:${String(c.asset_address).toLowerCase()}:${c.start_date}`,
      program: 'LIQUIDITY',
      venueMarket: String(m.condition_id),
      periodStart: new Date(`${c.start_date}T00:00:00Z`).toISOString(),
      // end_date is the last day paid.
      periodEnd: end.getUTCFullYear() >= OPEN_ENDED_YEAR ? null : new Date(end.getTime() + DAY_MS).toISOString(),
      reward: String(c.rate_per_day),
      rewardPer: 'DAY',
      definition: {
        minSize: Number(m.rewards_min_size),
        maxSpreadCents: Number(m.rewards_max_spread),
        asset: String(c.asset_address),
      },
      paidOut: null,
      sourceRef: REWARDS_URL,
      raw: null,
    };
  });
}

// Every page, or an error: a partial list would read as programs ending.
export async function readPolymarketIntlIncentivePrograms(): Promise<IncentiveProgramReading[]> {
  const programs: IncentiveProgramReading[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_REWARD_PAGES; page++) {
    const res = await fetchWithRetry(`${REWARDS_URL}${cursor ? `?next_cursor=${encodeURIComponent(cursor)}` : ''}`,
      () => ({ headers: { 'User-Agent': USER_AGENT } }));
    if (!res.ok) throw new Error(`Polymarket rewards page ${page} failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { data?: Record<string, any>[]; next_cursor?: string };
    const markets = body.data ?? [];
    programs.push(...markets.flatMap(parsePolymarketIntlRewardMarket));
    cursor = body.next_cursor ?? '';
    if (!cursor || cursor === LAST_CURSOR || markets.length === 0) return programs;
  }
  throw new Error(`Polymarket rewards ran past ${MAX_REWARD_PAGES} pages`);
}
