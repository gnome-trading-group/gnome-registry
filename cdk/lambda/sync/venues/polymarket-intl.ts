import { fetchWithRetry } from './http';
import { PollTarget, PRICE_SCALE, scaleDecimal, SIZE_SCALE, VenueReading } from './types';

// Polymarket Intl holds everything on chain, so an account is read with no credentials: its collateral is the
// funder wallet's pUSD balance on Polygon, its positions come from the public data API by that wallet's address.
// Resolved positions stay as tokens until redeemed, worth their payout.

const DATA_API = 'https://data-api.polymarket.com';
const PAGE_LIMIT = 500;
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
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    const res = await fetchWithRetry(`${DATA_API}/positions?user=${funder}&sizeThreshold=0&limit=${PAGE_LIMIT}&offset=${offset}`,
      () => ({ headers: { 'User-Agent': USER_AGENT } }));
    if (!res.ok) throw new Error(`Polymarket positions failed: ${res.status} ${await res.text()}`);
    const page = await res.json() as { asset: string; size: number | string; redeemable?: boolean; currentValue?: number }[];
    for (const p of page) {
      const value = p.currentValue === undefined ? null : scaleDecimal(p.currentValue, PRICE_SCALE);
      positions.push({
        venueKey: p.asset, quantity: scaleDecimal(p.size, SIZE_SCALE), redeemable: p.redeemable === true, value,
      });
      if (value !== null) portfolioValue += value;
      if (p.redeemable === true && value !== null) redeemableValue += value;
    }
    rows.push(...page);
    if (page.length < PAGE_LIMIT) break;
  }
  return {
    cashTotal: cash, cashAvailable: cash, portfolioValue, redeemableValue, positions, raw: { positions: rows },
  };
}
