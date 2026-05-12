import { ExchangeAdapter, Listing, ListingSpecData, Security } from './types';

const LIGHTER_MARKETS_URL = 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails';

interface LighterMarket {
  market_id: number;
  price_decimals: number;
  size_decimals: number;
  min_quote_amount: string;
}

interface LighterMarketsResponse {
  order_book_details: LighterMarket[];
}

export class LighterAdapter implements ExchangeAdapter {
  async fetchSpecs(listings: Listing[], _securities: Security[]): Promise<Map<number, ListingSpecData>> {
    const res = await fetch(LIGHTER_MARKETS_URL);
    const data = (await res.json()) as LighterMarketsResponse;

    const marketMap = new Map<number, LighterMarket>();
    for (const market of data.order_book_details ?? []) {
      marketMap.set(market.market_id, market);
    }

    const result = new Map<number, ListingSpecData>();

    for (const listing of listings) {
      const marketId = parseInt(listing.exchange_security_id, 10);
      if (isNaN(marketId)) {
        console.warn(`Lighter: non-numeric exchangeSecurityId "${listing.exchange_security_id}" (listingId=${listing.listing_id})`);
        continue;
      }

      const market = marketMap.get(marketId);
      if (!market) {
        console.warn(`Lighter: no market found for id=${marketId} (listingId=${listing.listing_id})`);
        continue;
      }

      // tickSize: smallest price step in PRICE_SCALING_FACTOR (1e9) units.
      // e.g. price_decimals=4 → step = 0.0001 → 0.0001 * 1e9 = 1e5 = 10^(9-4)
      // 0 if price_decimals exceeds the scaling factor — OMS skips tick enforcement when 0
      const tickSize = market.price_decimals > 9
        ? (console.warn(`Lighter: market ${marketId} price_decimals=${market.price_decimals} exceeds PRICE_SCALING_FACTOR (1e9) — storing tickSize=0`), 0)
        : Math.pow(10, 9 - market.price_decimals);
      // lotSize: smallest size step in SIZE_SCALING_FACTOR (1e6) units.
      // e.g. size_decimals=3 → step = 0.001 → 0.001 * 1e6 = 1e3 = 10^(6-3)
      // 0 if size_decimals exceeds the scaling factor — OMS skips lot enforcement when 0
      const lotSize = market.size_decimals > 6
        ? (console.warn(`Lighter: market ${marketId} size_decimals=${market.size_decimals} exceeds SIZE_SCALING_FACTOR (1e6) — storing lotSize=0`), 0)
        : Math.pow(10, 6 - market.size_decimals);
      // min_quote_amount is a USD value; scale to price*size units (1e9 * 1e6 = 1e15)
      const minNotional = parseFloat(market.min_quote_amount) * 1e15;

      result.set(listing.listing_id, { tickSize, lotSize, minNotional });
    }

    return result;
  }
}
