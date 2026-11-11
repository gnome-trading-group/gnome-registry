import { fetchWithRetry } from './http';
import { kalshiHeaders } from './signers';
import {
  PollTarget, PRICE_SCALE, RebalanceReading, RebalanceTargets, sameTargets, scaleDecimal, SIZE_SCALE, VenueReading,
} from './types';

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
