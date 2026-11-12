// What a venue reports for one account, in the registry's units: money in price units (1e9 per dollar), quantities
// in size units (1e6 per unit).
export interface VenueReading {
  cashTotal: bigint;
  cashAvailable: bigint;
  portfolioValue: bigint | null;
  redeemableValue: bigint;
  // Cash per partition where the venue splits it (Kalshi's exchange shards), keyed by partition.
  cashByPartition?: Record<string, bigint>;
  // How the venue moves cash between those partitions on its own, where it can.
  rebalanceTargets?: RebalanceReading;
  // Null when the venue can't list positions; only cash is reconciled then.
  positions: { venueKey: string; quantity: bigint; redeemable: boolean; value: bigint | null }[] | null;
  raw: unknown;
}

export type CreditKind = 'DEPOSIT' | 'WITHDRAWAL' | 'INTEREST' | 'REWARD' | 'FEE_ADJUSTMENT' | 'CORRECTION';
export type CreditProgram = 'LIQUIDITY' | 'MAKER_REBATE' | 'TAKER_REBATE' | 'HOLDING' | 'REFERRAL' | 'VOLUME' | 'INTEREST'
  | 'UNCLASSIFIED';

// Money the venue moved into or out of the account on its own, booked as a transfer under externalRef, which must be
// the same every time the venue reports it. amount is signed: in is positive.
export interface VenueCredit {
  externalRef: string;
  kind: CreditKind;
  program: CreditProgram | null;
  amount: bigint;
  occurredAt: Date;
  // The market the venue paid it for, in the venue's own terms, where it says.
  venueMarket: string | null;
  // The venue's own name for it, kept on the transfer as its reason.
  venueType: string;
  // Undoes an earlier credit (a withdrawal the venue returned): booked only if that one was.
  reverses?: string;
  raw: unknown;
}

// A credit the venue reported under a type the readers don't know yet: money in is still booked, so the cash
// reconciles, and flagged so someone maps it. Money out under an unknown type isn't booked: recon flags it as a break,
// for a person to explain, rather than its being written off unseen.
export function unclassifiedCredit(
  externalRef: string, amount: bigint, occurredAt: Date, venueType: string, raw: unknown, venueMarket: string | null = null,
): VenueCredit | null {
  if (amount < 0n) return null;
  return { externalRef, kind: 'REWARD', program: 'UNCLASSIFIED', amount, occurredAt, venueMarket, venueType, raw };
}

// Percent of sweepable cash per partition (empty: rebalancing is off), and what it leaves behind for resting orders.
export interface RebalanceTargets {
  allocations: Record<string, number>;
  restingMarginReservation: string;
}

// What the venue was found set to (absent when it couldn't be read), and why it couldn't be read or set.
export interface RebalanceReading {
  allocations?: Record<string, number>;
  restingMarginReservation?: string;
  error?: string;
}

// Zero-percent shards are the same as unnamed ones, so they don't count as a difference.
export function sameTargets(a: RebalanceTargets, b: RebalanceTargets): boolean {
  const named = (t: RebalanceTargets) => Object.entries(t.allocations).filter(([, p]) => p > 0)
    .sort(([x], [y]) => x.localeCompare(y)).map(([k, p]) => `${k}=${p}`).join(',');
  return named(a) === named(b) && a.restingMarginReservation === b.restingMarginReservation;
}

export interface PollTarget {
  account_id: number;
  exchange_id: number;
  exchange_code: string;
  label: string;
  venue_ref: Record<string, unknown>;
  read_secret_name: string | null;
  // The rebalancing the account should have, which the poller sets the venue to; null leaves it alone.
  partition_targets: Record<string, number> | null;
  rebalance_reservation: string;
  // Where to start reading the venue's credits from; null when the account isn't reconciled yet, so none are read.
  credits_since: string | null;
  // Rewards booked but not yet given to strategies, for which the venue's per-market breakdown is still wanted.
  pending_credits: PendingCredit[];
}

export interface PendingCredit {
  external_ref: string;
  program: CreditProgram;
  occurred_at: string;
  amount: string;
}

// Programs whose payouts the venue breaks down by market through an API of its own, which the poller reads.
export const BROKEN_DOWN_BY_VENUE: Record<string, CreditProgram[]> = {
  POLYMARKET_INTL: ['LIQUIDITY', 'MAKER_REBATE'],
  POLYMARKET_US: ['LIQUIDITY'],
};

// What the venue says a market earned: its amount, in the venue's terms, the time it was earned over, and the venue
// program's own period where it has one.
export interface BreakdownMarket {
  venueMarket: string;
  amount: bigint;
  from: Date;
  to: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
}

// What the venue says a payout was for, market by market. alternatives are other readings to try when markets don't
// add up to it; inArrears means markets is everything earned that may still be unpaid, of which the payout is the
// oldest periods (see treasury-allocate.ts).
export interface CreditBreakdown {
  externalRef: string;
  markets: BreakdownMarket[];
  alternatives?: BreakdownMarket[][];
  inArrears?: boolean;
}

export const DAY_MS = 86_400_000;

// The UTC day a daily payout was for: venues pay a day's rewards in the first hours of the next.
export function payoutDay(occurredAt: Date): Date {
  const shifted = new Date(occurredAt.getTime() - 6 * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

export const isoDate = (day: Date): string => day.toISOString().slice(0, 10);

export const PRICE_SCALE = 1_000_000_000n;
export const SIZE_SCALE = 1_000_000n;

// A decimal string or number (e.g. "18.62557") scaled to an integer, truncating past the scale's precision.
export function scaleDecimal(value: unknown, scale: bigint): bigint {
  // A JSON number this small prints in exponent form (1e-7); fixed notation keeps every digit the scale can hold.
  const text = (typeof value === 'number' ? value.toFixed(scale.toString().length - 1) : String(value ?? '0')).trim();
  if (!/^-?\d*(\.\d+)?$/.test(text) || text === '' || text === '-') throw new Error(`Not a decimal: ${text}`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const digits = scale.toString().length - 1;
  const scaled = BigInt(whole || '0') * scale + BigInt((fraction + '0'.repeat(digits)).slice(0, digits) || '0');
  return negative ? -scaled : scaled;
}

// A venue incentive program as the venue publishes it now, posted to /incentive-programs. reward is a decimal number of
// dollars, per period or per day by rewardPer; definition holds the venue's scoring terms (incentives/definition.ts).
export interface IncentiveProgramReading {
  venueProgramId: string;
  program: 'LIQUIDITY';
  venueMarket: string;
  periodStart: string;
  periodEnd: string | null;
  reward: string;
  rewardPer: 'PERIOD' | 'DAY';
  definition: Record<string, unknown>;
  paidOut: boolean | null;
  sourceRef: string;
  raw: unknown;
}
