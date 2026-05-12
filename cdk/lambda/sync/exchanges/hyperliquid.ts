import { ExchangeAdapter, Listing, ListingSpecData, Security } from './types';

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const PERPS_MAX_DECIMALS = 6;
const SPOT_MAX_DECIMALS = 8;
const SECURITY_TYPE_SPOT = 0;
const PERPS_MIN_NOTIONAL = 10;

interface HyperliquidAsset {
  name: string;
  szDecimals: number;
}

interface HyperliquidMetaResponse {
  universe: HyperliquidAsset[];
}

interface HyperliquidSpotToken {
  name: string;
  szDecimals: number;
}

interface HyperliquidSpotUniverse {
  name: string;
  tokens: number[];
}

interface HyperliquidSpotMetaResponse {
  tokens: HyperliquidSpotToken[];
  universe: HyperliquidSpotUniverse[];
}

async function fetchMeta(): Promise<Map<string, { szDecimals: number; isSpot: boolean }>> {
  const [perpsRes, spotRes] = await Promise.all([
    fetch(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' }),
    }),
    fetch(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotMeta' }),
    }),
  ]);

  const perps = (await perpsRes.json()) as HyperliquidMetaResponse;
  const spot = (await spotRes.json()) as HyperliquidSpotMetaResponse;

  const assetMap = new Map<string, { szDecimals: number; isSpot: boolean }>();

  for (const asset of perps.universe) {
    assetMap.set(asset.name, { szDecimals: asset.szDecimals, isSpot: false });
  }

  for (const token of spot.tokens) {
    assetMap.set(token.name, { szDecimals: token.szDecimals, isSpot: true });
  }

  return assetMap;
}

export class HyperliquidAdapter implements ExchangeAdapter {
  async fetchSpecs(listings: Listing[], securities: Security[]): Promise<Map<number, ListingSpecData>> {
    const assetMap = await fetchMeta();
    const securityMap = new Map(securities.map(s => [s.security_id, s]));
    const result = new Map<number, ListingSpecData>();

    for (const listing of listings) {
      const symbol = listing.exchange_security_symbol;
      const asset = assetMap.get(symbol);
      if (!asset) {
        console.warn(`Hyperliquid: no metadata found for symbol "${symbol}" (listingId=${listing.listing_id})`);
        continue;
      }

      const security = securityMap.get(listing.security_id);
      const isSpot = security?.type === SECURITY_TYPE_SPOT || asset.isSpot;
      const maxDecimals = isSpot ? SPOT_MAX_DECIMALS : PERPS_MAX_DECIMALS;

      const tickSize = Math.pow(10, maxDecimals - asset.szDecimals);
      const lotSize = Math.pow(10, asset.szDecimals);
      const minNotional = isSpot ? 0 : PERPS_MIN_NOTIONAL;

      result.set(listing.listing_id, { tickSize, lotSize, minNotional });
    }

    return result;
  }
}
