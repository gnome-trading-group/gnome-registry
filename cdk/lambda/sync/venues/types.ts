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
}

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
