import { PoolClient } from 'pg';
import { accountTreasury, AccountTreasury } from './treasury';

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

// Whether an account can carry one more session with this budget: its latest reading must be recent, and what the
// running sessions already claim plus this budget must leave the buffer free.
export function shortfall(account: AccountTreasury, budget: bigint): string | null {
  if (!account.snapshotFresh) {
    return `${account.exchangeCode} account ${account.label} has no recent balance snapshot; check the venue poller`;
  }
  if (account.allocated + budget > account.base - account.minBuffer) {
    return `${account.exchangeCode} account ${account.label} holds ${dollars(account.base)} with ${dollars(account.allocated)}`
      + ` allocated and ${dollars(account.minBuffer)} kept free, so it can't take a further ${dollars(budget)}`;
  }
  return null;
}

export async function requireAllocation(
  client: PoolClient, strategyId: number, exchangeId: number, exchangeCode: string, accountId: number, now: Date,
): Promise<void> {
  const budget = await allocationOf(client, strategyId, exchangeId);
  if (budget === null) {
    throw new LaunchCheckError(422,
      `A live session needs a MAX_COMMITTED_CAPITAL for the strategy on ${exchangeCode} (not only per listing)`);
  }
  const [account] = await accountTreasury(client, [accountId], now);
  const problem = shortfall(account, budget);
  if (problem) throw new LaunchCheckError(422, problem);
}
