import { registryFetch, resolveApiKey } from './registry-client';
import { kalshiQuotes, polymarketIntlQuotes, polymarketUsQuotes, Quote, UnwatchedListing } from './venues/books';

// Prices the listings still held once every session on them has stopped (a contract held to settlement), which no
// OMS marks any more. Runs every minute outside the VPC, as the venue poller does; VENUES limits a deployment to some
// exchange codes. A venue that can't be read is logged and left for the next minute: a long outage shows up as the
// positions' NO_PRICE alert. Only the registry failing fails the run.

const READERS: Record<string, (listings: UnwatchedListing[]) => Promise<Quote[]>> = {
  KALSHI: kalshiQuotes,
  POLYMARKET_INTL: polymarketIntlQuotes,
  POLYMARKET_US: polymarketUsQuotes,
};

export const handler = async () => {
  const apiKey = await resolveApiKey();
  const venues = (process.env.VENUES ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const post = (marks: Quote[]) => registryFetch<{ received: number; written: number; listings: UnwatchedListing[] }>(
    '/ledger/poller-marks', 'POST', apiKey, {
      marks: marks.map(q => ({
        listingId: q.listingId, bid: q.bid.toString(), ask: q.ask.toString(), lastTrade: q.lastTrade.toString(),
      })),
    });
  const listings = (await post([])).listings.filter(l => venues.length === 0 || venues.includes(l.exchange_code));
  if (listings.length === 0) return { listings: 0 };

  const byExchange = new Map<string, UnwatchedListing[]>();
  for (const l of listings) byExchange.set(l.exchange_code, [...(byExchange.get(l.exchange_code) ?? []), l]);
  const quotes: Quote[] = [];
  const venueErrors: Record<string, string> = {};
  for (const [exchange, group] of byExchange) {
    const read = READERS[exchange];
    if (!read) {
      venueErrors[exchange] = `no mark reader (${group.length} listing(s))`;
      continue;
    }
    try {
      quotes.push(...await read(group));
    } catch (error) {
      venueErrors[exchange] = error instanceof Error ? error.message : String(error);
      console.error(`Reading ${exchange} books failed: ${venueErrors[exchange]}`);
    }
  }

  const written = quotes.length === 0 ? 0 : (await post(quotes)).written;
  const result = { listings: listings.length, quoted: quotes.length, written, venueErrors };
  console.log('Mark poll:', JSON.stringify(result));
  return result;
};
