import { polymarketUsHeaders, polymarketUsKey } from './signers';
import { PollTarget, PRICE_SCALE, scaleDecimal, SIZE_SCALE, VenueReading } from './types';

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
  const headers = polymarketUsHeaders(credentials.apiKey, polymarketUsKey(credentials.secret), 'GET', path, Date.now());
  const res = await fetch(`${baseUrl}${path}`, { headers });
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
