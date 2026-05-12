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

      const tickSize = Math.pow(10, market.price_decimals);
      const lotSize = Math.pow(10, market.size_decimals);
      const minNotional = Math.round(parseFloat(market.min_quote_amount));

      result.set(listing.listing_id, { tickSize, lotSize, minNotional });
    }

    return result;
  }
}
