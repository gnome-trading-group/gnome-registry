import { fetchWithRetry } from './http';
import { kalshiHeaders } from './signers';
import { PollTarget, PRICE_SCALE, scaleDecimal, SIZE_SCALE, VenueReading } from './types';

// Kalshi reports money in cents rounded down, and to four decimals in its *_dollars fields, which sub-cent prices
// need; a position per market ticker, signed: YES positive, NO negative. Collateral is split by exchange shard
// (balance_breakdown); the account's total is what reconciles against the ledger.
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
  const cashByPartition: Record<string, bigint> = {};
  for (const shard of balance.balance_breakdown ?? []) {
    cashByPartition[String(shard.exchange_index)] = scaleDecimal(shard.balance, PRICE_SCALE);
  }
  return {
    cashTotal: cash,
    cashAvailable: cash,
    cashByPartition,
    portfolioValue,
    redeemableValue: 0n,
    positions,
    raw: { balance },
  };
}
