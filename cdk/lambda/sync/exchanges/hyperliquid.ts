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

interface HyperliquidSpotPair {
  name: string;
  tokens: number[]; // [baseTokenIndex, quoteTokenIndex]
}

interface HyperliquidSpotMetaResponse {
  tokens: HyperliquidSpotToken[];
  universe: HyperliquidSpotPair[];
}

interface PerpDex {
  name: string;
}

async function fetchPerpDexs(): Promise<string[]> {
  const res = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'perpDexs' }),
  });
  const dexes = (await res.json()) as (PerpDex | null)[];
  return dexes
    .filter((d): d is PerpDex => d !== null && typeof d.name === 'string')
    .map(d => d.name);
}

async function fetchDexMeta(dexName: string): Promise<HyperliquidAsset[]> {
  const res = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta', dex: dexName }),
  });
  const meta = (await res.json()) as HyperliquidMetaResponse;
  return meta.universe ?? [];
}

async function fetchMeta(): Promise<Map<string, { szDecimals: number; isSpot: boolean }>> {
  const [perpsRes, spotRes, dexNames] = await Promise.all([
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
    fetchPerpDexs(),
  ]);

  const perps = (await perpsRes.json()) as HyperliquidMetaResponse;
  const spot = (await spotRes.json()) as HyperliquidSpotMetaResponse;

  const assetMap = new Map<string, { szDecimals: number; isSpot: boolean }>();

  for (const asset of perps.universe) {
    assetMap.set(asset.name, { szDecimals: asset.szDecimals, isSpot: false });
  }

  // universe[i].name is the pair name (e.g. "PURR/USDC", "@107") — this is what's stored
  // as exchange_security_symbol. The base token is tokens[0]; use its szDecimals.
  for (const pair of spot.universe) {
    const baseToken = spot.tokens[pair.tokens[0]];
    if (baseToken) {
      assetMap.set(pair.name, { szDecimals: baseToken.szDecimals, isSpot: true });
    }
  }

  // DEX asset names are prefixed with the DEX name (e.g. "hyna:BTC"), so they merge
  // into the same map without colliding with main-exchange symbols.
  if (dexNames.length > 0) {
    const dexResults = await Promise.allSettled(dexNames.map(name => fetchDexMeta(name)));
    for (let i = 0; i < dexResults.length; i++) {
      const result = dexResults[i];
      if (result.status === 'rejected') {
        console.warn(`Hyperliquid: failed to fetch meta for DEX "${dexNames[i]}":`, result.reason);
        continue;
      }
      for (const asset of result.value) {
        assetMap.set(asset.name, { szDecimals: asset.szDecimals, isSpot: false });
      }
    }
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

      const priceDecimals = maxDecimals - asset.szDecimals;
      // tickSize: smallest price step in PRICE_SCALING_FACTOR (1e9) units.
      // e.g. 4 price decimals → step = 0.0001 → 0.0001 * 1e9 = 1e5 = 10^(9-4)
      // 0 if priceDecimals exceeds the scaling factor — OMS skips tick enforcement when 0
      const tickSize = priceDecimals > 9
        ? (console.warn(`Hyperliquid: "${symbol}" priceDecimals=${priceDecimals} exceeds PRICE_SCALING_FACTOR (1e9) — storing tickSize=0`), 0)
        : Math.pow(10, 9 - priceDecimals);
      // lotSize: smallest size step in SIZE_SCALING_FACTOR (1e6) units.
      // e.g. szDecimals=3 → step = 0.001 → 0.001 * 1e6 = 1e3 = 10^(6-3)
      // 0 if szDecimals exceeds the scaling factor — OMS skips lot enforcement when 0
      const lotSize = asset.szDecimals > 6
        ? (console.warn(`Hyperliquid: "${symbol}" szDecimals=${asset.szDecimals} exceeds SIZE_SCALING_FACTOR (1e6) — storing lotSize=0`), 0)
        : Math.pow(10, 6 - asset.szDecimals);
      // minNotional: minimum order value as price*size in scaled units.
      // price is in 1e9 units, size is in 1e6 units, so USD * 1e9 * 1e6 = USD * 1e15
      const minNotional = isSpot ? 0 : PERPS_MIN_NOTIONAL * 1e15;

      result.set(listing.listing_id, { tickSize, lotSize, minNotional });
    }

    return result;
  }
}
