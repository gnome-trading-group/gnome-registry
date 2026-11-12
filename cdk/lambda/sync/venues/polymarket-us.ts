import { fetchWithRetry } from './http';
import { polymarketUsHeaders, polymarketUsKey } from './signers';
import {
  CreditBreakdown, CreditKind, CreditProgram, DAY_MS, isoDate, PendingCredit, PollTarget, PRICE_SCALE, scaleDecimal,
  SIZE_SCALE, unclassifiedCredit, VenueCredit, VenueReading,
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
  return {
    cashTotal: total - margin, cashAvailable: available, portfolioValue, redeemableValue: 0n, positions,
    raw: { balances, positions: pages, account: target.label },
  };
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
  const noon = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: VENUE_ZONE, hour: 'numeric', hourCycle: 'h23' })
    .format(noon));
  return new Date(noon.getTime() - hour * 3_600_000);
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
