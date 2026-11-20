import { fetchWithRetry } from './http';
import { polymarketIntlHeaders } from './signers';
import {
  BreakdownMarket, CreditBreakdown, CreditKind, CreditProgram, DAY_MS, isoDate, payoutDay, PendingCredit, PollTarget,
  PRICE_SCALE, scaleDecimal, SETTLEMENT_LOOKBACK_MS, SIZE_SCALE, VenueCredit, VenueReading, VenueSettlement,
} from './types';
import { IncentiveProgramReading } from './types';
import {
  chunks, inParallel, pause, PRICE_SCALE as SPEC_PRICE_SCALE, ReadOptions, SIZE_SCALE as SPEC_SIZE_SCALE, units, VenueSpec,
} from './specs';

// Polymarket Intl holds everything on chain, so an account is read with no credentials: its collateral is the
// funder wallet's pUSD balance on Polygon, and the public data API lists the outcome tokens that wallet holds.
// The API truncates each holding to 4 decimals while fills land at 6 (a maker filled by a taker's dollar amount gets
// 5.555556), so how many of each token the wallet holds is read from the token contract itself, which the ledger
// matches to the unit. Resolved positions stay as tokens until redeemed, worth their payout.

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
const BALANCE_OF_BATCH = '0x4e1273f4';
// Public nodes rate-limit by request, so a wallet's tokens go in as few calls as fit.
const BATCH_TOKENS = 100;

function word(value: bigint | number | string): string {
  return BigInt(value).toString(16).padStart(64, '0');
}

async function ethCall(to: string, data: string, what: string): Promise<string> {
  const rpc = process.env.POLYGON_RPC_URL;
  if (!rpc) throw new Error('POLYGON_RPC_URL must be set to read Polymarket Intl');
  const res = await fetchWithRetry(rpc, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  }), async answer => !(await answer.json().catch(() => ({})) as { result?: string }).result);
  const body = await res.json() as { result?: string; error?: { message: string } };
  if (!res.ok || !body.result) throw new Error(`Polygon ${what} failed: ${res.status} ${body.error?.message ?? ''}`);
  return body.result;
}

async function collateral(funder: string): Promise<bigint> {
  const token = process.env.PUSD_TOKEN_ADDRESS;
  if (!token) throw new Error('PUSD_TOKEN_ADDRESS must be set to read Polymarket Intl cash');
  return BigInt(await ethCall(token, `${BALANCE_OF}${word(funder)}`, 'balanceOf')) * PUSD_TO_PRICE;
}

// The wallet's balance of each outcome token, in the token's own 6 decimals: size units.
async function tokenBalances(funder: string, tokenIds: string[]): Promise<bigint[]> {
  const ctf = process.env.CTF_TOKEN_ADDRESS;
  if (!ctf) throw new Error('CTF_TOKEN_ADDRESS must be set to read Polymarket Intl positions');
  const balances: bigint[] = [];
  for (let i = 0; i < tokenIds.length; i += BATCH_TOKENS) {
    const ids = tokenIds.slice(i, i + BATCH_TOKENS);
    const n = ids.length;
    // balanceOfBatch(address[] owners, uint256[] ids): two offsets, then each array as its length and items.
    const data = BALANCE_OF_BATCH + word(64) + word(64 + 32 * (n + 1))
      + word(n) + word(funder).repeat(n) + word(n) + ids.map(word).join('');
    const result = (await ethCall(ctf, data, 'balanceOfBatch')).replace(/^0x/, '');
    const words = result.match(/.{64}/g)?.map(w => BigInt(`0x${w}`)) ?? [];
    if (words.length !== n + 2 || words[1] !== BigInt(n)) {
      throw new Error(`Polygon balanceOfBatch answered ${words.length} words for ${n} tokens`);
    }
    balances.push(...words.slice(2));
  }
  return balances;
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
      positions.push({ venueKey: p.token_id, quantity: 0n, redeemable: p.redeemable === true, value });
      if (value !== null) portfolioValue += value;
      if (p.redeemable === true && value !== null) redeemableValue += value;
    }
    rows.push(...(body.data ?? []));
    cursor = body.pagination.next_cursor;
  } while (cursor !== null);
  const balances = await tokenBalances(funder, positions.map(p => p.venueKey));
  positions.forEach((p, i) => { p.quantity = balances[i]; });
  // Without them recon only waits for the classifier, as it always could; that's no reason to lose the reading.
  let settlementsError: string | undefined;
  const settlements = await readPolymarketIntlRedemptions(funder).catch((error: unknown) => {
    settlementsError = error instanceof Error ? error.message : String(error);
    console.error(`Reading ${target.label} redemptions failed: ${settlementsError}`);
    return undefined;
  });
  return {
    cashTotal: cash, cashAvailable: cash, portfolioValue, redeemableValue, positions, settlements,
    raw: { positions: rows, ...(settlementsError ? { settlementsError } : {}) },
  };
}

// A wallet that redeems resolved tokens as soon as it can holds them for seconds, so they leave the positions list
// long before the classifier records the market's value. Each redemption names the token and how many paid how much,
// which is the market's settlement for that token. Its price field reads 0 even for a winner, so it isn't used.
export function parsePolymarketIntlRedemption(row: Record<string, any>): VenueSettlement | null {
  if (row.type !== 'REDEEM' || typeof row.token_id !== 'string' || row.token_id === '') return null;
  const size = scaleDecimal(row.size, SIZE_SCALE);
  const settledAt = new Date(Number(row.timestamp) * 1000);
  if (size <= 0n || row.usdc_size == null || Number.isNaN(settledAt.getTime())) return null;
  return { venueKey: row.token_id, settledAt, price: scaleDecimal(row.usdc_size, PRICE_SCALE) * SIZE_SCALE / size };
}

async function readPolymarketIntlRedemptions(funder: string): Promise<VenueSettlement[]> {
  // Like the credits, activity wants the user on every page, cursor or not.
  const filters = `user=${funder}&limit=${PAGE_LIMIT}&type=REDEEM`
    + `&start=${Math.floor((Date.now() - SETTLEMENT_LOOKBACK_MS) / 1000)}`;
  const settlements: VenueSettlement[] = [];
  let cursor: string | null = null;
  do {
    const page = cursor === null ? filters : `${filters}&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetchWithRetry(`${DATA_API}/activity?${page}`, () => ({ headers: { 'User-Agent': USER_AGENT } }));
    if (!res.ok) throw new Error(`Polymarket redemptions failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { data: Record<string, any>[] | null; pagination?: { next_cursor: string | null } };
    settlements.push(...(body.data ?? []).map(parsePolymarketIntlRedemption).filter((s): s is VenueSettlement => s !== null));
    cursor = body.pagination?.next_cursor ?? null;
  } while (cursor !== null);
  return settlements;
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

/**
 * When a program a complete read no longer lists ended: Polymarket pays per UTC day and doesn't say whether a part day
 * is paid, so the day it went missing isn't.
 */
export function polymarketIntlUnlistedEnd(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
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

// ----- listing specs -----

const GAMMA_API = 'https://gamma-api.polymarket.com';
// Every token trades in ten-thousandths of a share; resting orders need the market's orderMinSize shares. The CLOB's
// $1 minimum applies only to marketable orders, which the OMS can't tell apart, so min_notional stays 0.
const POLYMARKET_INTL_LOT_SIZE = 10_000;
// Markets per Gamma request: about 80 characters each in the URL.
const CONDITIONS_PER_REQUEST = 100;
const PAUSE_BETWEEN_REQUESTS_MS = 250;
// Gamma requests in flight at once, each still pausing after itself: a full pass's ~600 pages in a minute or two.
const GAMMA_REQUESTS_AT_ONCE = 4;

/** The market and token a listing trades: `{condition_id}:{token_id}`. */
export function polymarketIntlMarketOf(exchangeSecurityId: string): { conditionId: string; tokenId: string } {
  const colon = exchangeSecurityId.indexOf(':');
  return { conditionId: exchangeSecurityId.slice(0, colon), tokenId: exchangeSecurityId.slice(colon + 1) };
}

async function gammaMarkets(conditionIds: string[], closed: boolean): Promise<Record<string, any>[]> {
  const query = conditionIds.map(id => `condition_ids=${encodeURIComponent(id)}`).join('&');
  const res = await fetchWithRetry(`${GAMMA_API}/markets?${query}&limit=${conditionIds.length}${closed ? '&closed=true' : ''}`);
  if (!res.ok) throw new Error(`Polymarket Gamma GET /markets failed: ${res.status} ${await res.text()}`);
  return await res.json() as Record<string, any>[];
}

// Gamma sometimes leaves a market's tick or minimum out; the CLOB's market has both, and a default would be a guess.
// Only a 404 means the CLOB doesn't know the market: any other failure throws, since reading it as "unknown" would
// quietly leave the listing on whatever spec it had.
async function clobMarket(conditionId: string): Promise<{ tick: number | null; minSize: number | null }> {
  const res = await fetchWithRetry(`${CLOB_API}/markets/${encodeURIComponent(conditionId)}`);
  if (res.status === 404) return { tick: null, minSize: null };
  if (!res.ok) throw new Error(`Polymarket CLOB GET /markets/${conditionId} failed: ${res.status} ${await res.text()}`);
  const market = await res.json() as Record<string, unknown>;
  return { tick: units(market.minimum_tick_size, SPEC_PRICE_SCALE), minSize: units(market.minimum_order_size, SPEC_SIZE_SCALE) };
}

/**
 * Specs for Polymarket Intl listings: one tick for the whole market (both tokens) at a time, which the venue makes finer
 * near 0 and 1; read from Gamma, open markets first and then closed ones, with the CLOB filling in what Gamma omits,
 * whole markets included (Gamma stops listing old closed markets the CLOB still knows).
 */
export async function readPolymarketIntlSpecs(
  exchangeSecurityIds: string[], options: ReadOptions = {},
): Promise<Map<string, VenueSpec>> {
  const listingsByCondition = new Map<string, string[]>();
  for (const id of exchangeSecurityIds) {
    const { conditionId } = polymarketIntlMarketOf(id);
    listingsByCondition.set(conditionId, [...(listingsByCondition.get(conditionId) ?? []), id]);
  }
  const found = new Map<string, { tick: number | null; minSize: number | null }>();
  for (const closed of options.listedOnly ? [false] : [false, true]) {
    const wanted = [...listingsByCondition.keys()].filter(c => !found.has(c));
    await inParallel(chunks(wanted, CONDITIONS_PER_REQUEST), GAMMA_REQUESTS_AT_ONCE, async batch => {
      for (const market of await gammaMarkets(batch, closed)) {
        found.set(String(market.conditionId), {
          tick: units(market.orderPriceMinTickSize, SPEC_PRICE_SCALE),
          minSize: units(market.orderMinSize, SPEC_SIZE_SCALE),
        });
      }
      await pause(PAUSE_BETWEEN_REQUESTS_MS);
    });
  }
  const specs = new Map<string, VenueSpec>();
  for (const [conditionId, ids] of listingsByCondition) {
    let terms = found.get(conditionId) ?? { tick: null, minSize: null };
    if (options.listedOnly && !found.has(conditionId)) continue;
    if (terms.tick === null || terms.minSize === null) {
      const clob = await clobMarket(conditionId);
      terms = { tick: terms.tick ?? clob.tick, minSize: terms.minSize ?? clob.minSize };
      await pause(PAUSE_BETWEEN_REQUESTS_MS);
    }
    if (terms.tick === null || terms.tick <= 0 || terms.minSize === null) {
      console.warn(`Polymarket Intl market ${conditionId} has no tick or minimum size on Gamma or the CLOB`);
      continue;
    }
    for (const id of ids) {
      specs.set(id, {
        priceBands: [{ start: 0, end: SPEC_PRICE_SCALE, step: terms.tick }],
        lotSize: POLYMARKET_INTL_LOT_SIZE,
        minNotional: 0,
        minSize: terms.minSize,
        contractMultiplier: SPEC_PRICE_SCALE,
      });
    }
  }
  return specs;
}

/** A token's tick on the CLOB now, which a shard's tick_size_change refresh checks against; null if it can't say. */
export async function readPolymarketIntlTick(tokenId: string): Promise<number | null> {
  const res = await fetchWithRetry(`${CLOB_API}/tick-size?token_id=${encodeURIComponent(tokenId)}`);
  if (!res.ok) return null;
  return units(((await res.json()) as Record<string, unknown>).minimum_tick_size, SPEC_PRICE_SCALE);
}
