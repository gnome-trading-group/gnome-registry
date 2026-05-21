import { AssetClass, ContractType, ExchangeAdapter, ExchangeSecurityData, SecurityType } from './types';

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const PERPS_MAX_DECIMALS = 6;
const SPOT_MAX_DECIMALS = 8;
const CONTRACT_MULTIPLIER = 1_000_000_000;
const PERPS_MIN_NOTIONAL = 10;

interface HyperliquidAsset {
  name: string;
  szDecimals: number;
}

interface HyperliquidMetaAndAssetCtxs {
  collateralToken: number;
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

async function infoPost<T>(body: unknown): Promise<T> {
  const res = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

async function fetchPerpDexs(): Promise<string[]> {
  const dexes = await infoPost<(PerpDex | null)[]>({ type: 'perpDexs' });
  return dexes
    .filter((d): d is PerpDex => d !== null && typeof d.name === 'string')
    .map(d => d.name);
}

async function fetchMetaAndAssetCtxs(dex?: string): Promise<HyperliquidMetaAndAssetCtxs> {
  const body: Record<string, string> = { type: 'metaAndAssetCtxs' };
  if (dex) body.dex = dex;
  // Response is a tuple [metadata, assetContextsArray]; we only need metadata
  const [metadata] = await infoPost<[HyperliquidMetaAndAssetCtxs, unknown[]]>(body);
  return metadata;
}

function perpFromAsset(
  asset: HyperliquidAsset,
  exchangeSecuritySymbol: string,
  settleCurrency: string,
): ExchangeSecurityData {
  const priceDecimals = PERPS_MAX_DECIMALS - asset.szDecimals;
  const tickSize = priceDecimals > 9
    ? (console.warn(`Hyperliquid: "${exchangeSecuritySymbol}" priceDecimals=${priceDecimals} exceeds PRICE_SCALING_FACTOR (1e9) — storing tickSize=0`), 0)
    : Math.pow(10, 9 - priceDecimals);
  const lotSize = asset.szDecimals > 6
    ? (console.warn(`Hyperliquid: "${exchangeSecuritySymbol}" szDecimals=${asset.szDecimals} exceeds SIZE_SCALING_FACTOR (1e6) — storing lotSize=0`), 0)
    : Math.pow(10, 6 - asset.szDecimals);

  // Strip DEX prefix (e.g. "hyna:BTC" -> "BTC") to get the canonical base currency
  const colonIdx = asset.name.indexOf(':');
  const baseCurrency = colonIdx >= 0 ? asset.name.slice(colonIdx + 1) : asset.name;

  return {
    baseCurrency,
    quoteCurrency: settleCurrency,
    settleCurrency,
    securitySymbol: `${baseCurrency}-${settleCurrency}-PERP`,
    securityType: SecurityType.PERPETUAL,
    contractType: ContractType.LINEAR_PERPETUAL,
    assetClass: AssetClass.CRYPTO,
    inverse: false,
    isQuanto: false,
    exchangeSecurityId: exchangeSecuritySymbol,
    exchangeSecuritySymbol,
    tickSize,
    lotSize,
    minNotional: PERPS_MIN_NOTIONAL * 1e15,
    contractMultiplier: CONTRACT_MULTIPLIER,
  };
}

export class HyperliquidAdapter implements ExchangeAdapter {
  async fetchSecurities(): Promise<ExchangeSecurityData[]> {
    const [mainMeta, spot, dexNames] = await Promise.all([
      fetchMetaAndAssetCtxs(),
      infoPost<HyperliquidSpotMetaResponse>({ type: 'spotMeta' }),
      fetchPerpDexs(),
    ]);

    const resolveSettle = (collateralToken: number): string =>
      spot.tokens[collateralToken]?.name ?? 'USDC';

    const result: ExchangeSecurityData[] = [];

    // Main-exchange perpetuals
    const mainSettle = resolveSettle(mainMeta.collateralToken);
    for (const asset of mainMeta.universe) {
      result.push(perpFromAsset(asset, asset.name, mainSettle));
    }

    // Spot pairs
    for (const pair of spot.universe) {
      const baseToken = spot.tokens[pair.tokens[0]];
      const quoteToken = spot.tokens[pair.tokens[1]];
      if (!baseToken || !quoteToken) continue;

      const priceDecimals = SPOT_MAX_DECIMALS - baseToken.szDecimals;
      const tickSize = priceDecimals > 9
        ? (console.warn(`Hyperliquid: spot "${pair.name}" priceDecimals=${priceDecimals} exceeds PRICE_SCALING_FACTOR — storing tickSize=0`), 0)
        : Math.pow(10, 9 - priceDecimals);
      const lotSize = baseToken.szDecimals > 6
        ? (console.warn(`Hyperliquid: spot "${pair.name}" szDecimals=${baseToken.szDecimals} exceeds SIZE_SCALING_FACTOR — storing lotSize=0`), 0)
        : Math.pow(10, 6 - baseToken.szDecimals);

      result.push({
        baseCurrency: baseToken.name,
        quoteCurrency: quoteToken.name,
        settleCurrency: quoteToken.name,
        securitySymbol: `${baseToken.name}-${quoteToken.name}-SPOT`,
        securityType: SecurityType.SPOT,
        contractType: ContractType.NONE,
        assetClass: AssetClass.CRYPTO,
        inverse: false,
        isQuanto: false,
        exchangeSecurityId: pair.name,
        exchangeSecuritySymbol: pair.name,
        tickSize,
        lotSize,
        minNotional: 0,
        contractMultiplier: CONTRACT_MULTIPLIER,
      });
    }

    // Sub-DEX perpetuals
    const dexResults = await Promise.allSettled(dexNames.map(name => fetchMetaAndAssetCtxs(name)));
    for (let i = 0; i < dexResults.length; i++) {
      const result_i = dexResults[i];
      if (result_i.status === 'rejected') {
        console.warn(`Hyperliquid: failed to fetch meta for DEX "${dexNames[i]}":`, result_i.reason);
        continue;
      }
      const dexSettle = resolveSettle(result_i.value.collateralToken);
      for (const asset of result_i.value.universe) {
        result.push(perpFromAsset(asset, asset.name, dexSettle));
      }
    }

    return result;
  }
}
