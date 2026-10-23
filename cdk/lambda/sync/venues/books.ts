import { fetchWithRetry } from './http';
import { PRICE_SCALE, scaleDecimal, SIZE_SCALE } from './types';

// Top of book and last trade for listings no session is on, read from each venue's public market data (no account
// needed) and put in the listing's own terms. Kalshi and Polymarket US keep one book per market, so a NO or short
// listing is priced as its complement, as the gateways price it: its bids are the market's asks at 1 - p. 0 means a
// side or trade is unknown. A listing its venue no longer trades (closed, resolved, unknown to it) gets no quote, and
// one whose market can't be read is logged and skipped, so neither stops the rest from being priced.

export interface UnwatchedListing {
  listing_id: number;
  exchange_code: string;
  exchange_security_id: string | null;
}

export interface Quote {
  listingId: number;
  bid: bigint;
  ask: bigint;
  lastTrade: bigint;
}

const KALSHI_BATCH = 100;
const POLYMARKET_BATCH = 50;
// The security master lists production markets in every stage (dev's paper sessions trade them too), so the books
// are always production's, even where dev's accounts trade on Kalshi's demo exchange.
const KALSHI_API = 'https://external-api.kalshi.com';
const CLOB_API = 'https://clob.polymarket.com';
const POLYMARKET_US_GATEWAY = 'https://gateway.polymarket.us/v1';

const complement = (price: bigint) => (price === 0n ? 0n : PRICE_SCALE - price);

// A binary contract only trades strictly between 0 and 1; venues show an empty side at either end.
function price(value: unknown): bigint {
  if (value === undefined || value === null || value === '') return 0n;
  const scaled = scaleDecimal(value, PRICE_SCALE);
  return scaled > 0n && scaled < PRICE_SCALE ? scaled : 0n;
}

function inTerms(listingId: number, complemented: boolean, bid: bigint, ask: bigint, lastTrade: bigint): Quote {
  return complemented
    ? { listingId, bid: complement(ask), ask: complement(bid), lastTrade: complement(lastTrade) }
    : { listingId, bid, ask, lastTrade };
}

function split(securityId: string): { market: string; side: string } {
  const colon = securityId.indexOf(':');
  return colon < 0 ? { market: securityId, side: '' } : { market: securityId.slice(0, colon), side: securityId.slice(colon + 1) };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function quoteEach<M>(listings: UnwatchedListing[], marketOf: (l: UnwatchedListing) => M | undefined,
  quote: (l: UnwatchedListing, market: M) => Quote | null): Quote[] {
  const quotes: Quote[] = [];
  for (const listing of listings) {
    const market = marketOf(listing);
    if (market === undefined) continue;
    try {
      const q = quote(listing, market);
      if (q) quotes.push(q);
    } catch (error) {
      console.error(`Pricing listing ${listing.listing_id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return quotes;
}

// Kalshi shows an empty side as a zero size (its price can read 0 or 1); only an active market is trading.
function kalshiSide(value: unknown, size: unknown): bigint {
  if (size !== undefined && size !== null && scaleDecimal(size, SIZE_SCALE) <= 0n) return 0n;
  return price(value);
}

export function kalshiQuote(listing: UnwatchedListing, market: Record<string, any>): Quote | null {
  if (market.status !== 'active') return null;
  return inTerms(listing.listing_id, split(listing.exchange_security_id ?? '').side.toLowerCase() === 'no',
    kalshiSide(market.yes_bid_dollars, market.yes_bid_size_fp),
    kalshiSide(market.yes_ask_dollars, market.yes_ask_size_fp),
    price(market.last_price_dollars));
}

// Each Polymarket Intl outcome token has its own book. The CLOB lists levels worst first, so the best is searched for.
export function polymarketIntlQuote(listing: UnwatchedListing, book: Record<string, any>): Quote {
  const levels = (side: unknown) => (Array.isArray(side) ? side : [])
    .filter((l: any) => scaleDecimal(l?.size ?? 0, SIZE_SCALE) > 0n).map((l: any) => price(l.price)).filter(p => p > 0n);
  const bids = levels(book.bids);
  const asks = levels(book.asks);
  return {
    listingId: listing.listing_id,
    bid: bids.reduce((best, p) => (p > best ? p : best), 0n),
    ask: asks.reduce((best, p) => (best === 0n || p < best ? p : best), 0n),
    lastTrade: price(book.last_trade_price),
  };
}

// Polymarket US quotes the long side's best bid and ask with no last trade; an empty side has no quote at all.
export function polymarketUsQuote(listing: UnwatchedListing, market: Record<string, any>): Quote | null {
  if (market.closed === true || market.status !== 'MARKET_STATUS_OPEN') return null;
  return inTerms(listing.listing_id, split(listing.exchange_security_id ?? '').side.toLowerCase() === 'short',
    price(market.bestBidQuote?.value), price(market.bestAskQuote?.value), 0n);
}

async function getJson(url: string, init?: () => RequestInit): Promise<any> {
  const res = await fetchWithRetry(url, init);
  if (!res.ok) throw new Error(`GET ${url.split('?')[0]} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function kalshiQuotes(listings: UnwatchedListing[]): Promise<Quote[]> {
  const markets = new Map<string, Record<string, any>>();
  const tickers = [...new Set(listings.map(l => split(l.exchange_security_id ?? '').market).filter(Boolean))];
  for (const batch of chunks(tickers, KALSHI_BATCH)) {
    const page = await getJson(
      `${KALSHI_API}/trade-api/v2/markets?limit=${KALSHI_BATCH}&tickers=${batch.map(encodeURIComponent).join(',')}`);
    for (const m of page.markets ?? []) markets.set(m.ticker, m);
  }
  return quoteEach(listings, l => markets.get(split(l.exchange_security_id ?? '').market), kalshiQuote);
}

export async function polymarketIntlQuotes(listings: UnwatchedListing[]): Promise<Quote[]> {
  const tokenOf = (l: UnwatchedListing) => {
    const id = l.exchange_security_id ?? '';
    return id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  };
  const books = new Map<string, Record<string, any>>();
  const tokens = [...new Set(listings.map(tokenOf).filter(Boolean))];
  for (const batch of chunks(tokens, POLYMARKET_BATCH)) {
    const res = await fetchWithRetry(`${CLOB_API}/books`, () => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.map(token_id => ({ token_id }))),
    }));
    if (!res.ok) throw new Error(`Polymarket POST /books failed: ${res.status} ${await res.text()}`);
    for (const book of await res.json() as Record<string, any>[]) books.set(String(book.asset_id), book);
  }
  return quoteEach(listings, l => books.get(tokenOf(l)), polymarketIntlQuote);
}

export async function polymarketUsQuotes(listings: UnwatchedListing[]): Promise<Quote[]> {
  const markets = new Map<string, Record<string, any>>();
  const slugs = [...new Set(listings.map(l => split(l.exchange_security_id ?? '').market).filter(Boolean))];
  for (const batch of chunks(slugs, POLYMARKET_BATCH)) {
    const query = batch.map(s => `slug=${encodeURIComponent(s)}`).join('&');
    const page = await getJson(`${POLYMARKET_US_GATEWAY}/markets?${query}&limit=${batch.length}`);
    for (const m of page.markets ?? []) markets.set(m.slug, m);
  }
  return quoteEach(listings, l => markets.get(split(l.exchange_security_id ?? '').market), polymarketUsQuote);
}
