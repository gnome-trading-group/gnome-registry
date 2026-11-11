import { PoolClient } from 'pg';
import { accountTreasury, AccountTreasury, sweptPartitions } from './treasury';

// What a live session needs before it may be created. Both run inside the transaction that creates it, under the
// per-exchange account lock, so two launches can't each pass on the same money.

// Every listing a live session trades must be covered by an enabled policy of each type: limits on what it can tie
// up, lose, hold, and how long it keeps sending orders a venue refuses. The OMS refuses to trade without them too.
export const REQUIRED_LIVE_POLICIES = [
  'MAX_COMMITTED_CAPITAL', 'MAX_TOTAL_PNL_LOSS', 'MAX_POSITION', 'MAX_CONSECUTIVE_REJECTS',
];

export class LaunchCheckError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

// A row covers a listing when every id it names matches: no session (a new session has none yet), this strategy or
// none, this listing or none, the listing's exchange or none.
export async function missingPolicies(
  client: PoolClient, strategyId: number, listings: number[],
): Promise<{ listingId: number; policyType: string }[]> {
  return (await client.query(
    `SELECT l.listing_id, t.policy_type
     FROM sm.listing l CROSS JOIN unnest($3::text[]) AS t(policy_type)
     WHERE l.listing_id = ANY($2::int[])
       AND NOT EXISTS (
         SELECT 1 FROM risk.policy p
         WHERE p.enabled AND p.policy_type = t.policy_type AND p.session_id IS NULL
           AND (p.strategy_id IS NULL OR p.strategy_id = $1)
           AND (p.listing_id IS NULL OR p.listing_id = l.listing_id)
           AND (p.exchange_id IS NULL OR p.exchange_id = l.exchange_id))
     ORDER BY l.listing_id, t.policy_type`,
    [strategyId, listings, REQUIRED_LIVE_POLICIES])).rows.map(r => ({ listingId: r.listing_id, policyType: r.policy_type }));
}

export async function requireCoverage(client: PoolClient, strategyId: number, listings: number[]): Promise<void> {
  const missing = await missingPolicies(client, strategyId, listings);
  if (missing.length > 0) {
    throw new LaunchCheckError(422, 'A live session needs every required risk policy on each listing; missing '
      + missing.map(m => `${m.policyType} on listing ${m.listingId}`).join(', '));
  }
}

export async function allocationOf(client: PoolClient, strategyId: number, exchangeId: number): Promise<bigint | null> {
  const row = (await client.query(
    'SELECT max_capital FROM treasury.allocation WHERE strategy_id = $1 AND exchange_id = $2',
    [strategyId, exchangeId])).rows[0];
  return row ? BigInt(row.max_capital) : null;
}

function dollars(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}$${abs / 1_000_000_000n}.${String((abs % 1_000_000_000n) / 10_000_000n).padStart(2, '0')}`;
}

// The venue partitions a session's listings on one exchange trade on (Kalshi exchange shards), and those whose
// partition isn't known yet.
export interface SessionPartitions {
  partitions: string[];
  unknownListings: number[];
}

export async function sessionPartitions(
  client: PoolClient, listings: number[], exchangeId: number,
): Promise<SessionPartitions> {
  const rows = (await client.query(
    'SELECT listing_id, venue_partition FROM sm.listing WHERE listing_id = ANY($1::int[]) AND exchange_id = $2',
    [listings, exchangeId])).rows;
  return {
    partitions: [...new Set(rows.filter(r => r.venue_partition !== null).map(r => r.venue_partition as string))].sort(),
    unknownListings: rows.filter(r => r.venue_partition === null).map(r => r.listing_id as number),
  };
}

// Whether an account can carry one more session with this budget: its latest reading must be recent, and what the
// running sessions already claim plus this budget must leave the buffer free. Where the venue splits cash by
// partition, each partition the session trades must carry the whole budget too, since its cash backs no other
// partition's orders.
export function shortfall(account: AccountTreasury, budget: bigint, session: SessionPartitions): string | null {
  const name = `${account.exchangeCode} account ${account.label}`;
  if (!account.snapshotFresh) {
    return `${name} has no recent balance snapshot; check the venue poller`;
  }
  if (account.allocated + budget > account.base - account.minBuffer) {
    return `${name} holds ${dollars(account.base)} with ${dollars(account.allocated)}`
      + ` allocated and ${dollars(account.minBuffer)} kept free, so it can't take a further ${dollars(budget)}`;
  }
  if (account.partitions === null) return null;
  if (session.unknownListings.length > 0) {
    return `${account.exchangeCode} splits cash by shard, and listing(s) ${session.unknownListings.join(', ')} have no`
      + ' known shard yet; the classifier records it';
  }
  const swept = sweptPartitions(account, session.partitions);
  if (swept.length > 0) {
    return `${name} rebalances its cash off shard ${swept.join(', ')}, which this session trades; give it a share of the`
      + ' rebalancing targets';
  }
  for (const key of session.partitions) {
    const partition = account.partitions[key];
    const base = partition?.base ?? 0n;
    const allocated = partition?.allocated ?? 0n;
    if (allocated + budget > base) {
      return `${name} holds ${dollars(base)} on shard ${key} with ${dollars(allocated)} allocated there, so it can't`
        + ` take a further ${dollars(budget)}; move cash onto shard ${key}`;
    }
  }
  return null;
}

export async function requireAllocation(
  client: PoolClient, strategyId: number, exchangeId: number, exchangeCode: string, accountId: number,
  session: SessionPartitions, now: Date,
): Promise<void> {
  const budget = await allocationOf(client, strategyId, exchangeId);
  if (budget === null) {
    throw new LaunchCheckError(422,
      `A live session needs a MAX_COMMITTED_CAPITAL for the strategy on ${exchangeCode} (not only per listing)`);
  }
  const [account] = await accountTreasury(client, [accountId], now);
  const problem = shortfall(account, budget, session);
  if (problem) throw new LaunchCheckError(422, problem);
}
