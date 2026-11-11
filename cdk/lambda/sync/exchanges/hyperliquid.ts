import { AssetClass, ContractType, ExchangeAdapter, ExchangeFetch, ExchangeSecurityData, SecurityType } from './types';

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const PERPS_MAX_DECIMALS = 6;
const SPOT_MAX_DECIMALS = 8;
const CONTRACT_MULTIPLIER = 1_000_000_000;
const PERPS_MIN_NOTIONAL = 10;

interface HyperliquidAsset {
  name: string;
  szDecimals: number;
  isDelisted?: boolean;
}

interface HyperliquidAssetCtx {
  dayNtlVlm?: string;
}

interface HyperliquidMeta {
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

interface HyperliquidSpotMeta {
  tokens: HyperliquidSpotToken[];
  universe: HyperliquidSpotPair[];
}

interface HyperliquidSpotCtx {
  coin: string;
  dayNtlVlm?: string;
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
  if (!res.ok) {
    throw new Error(`Hyperliquid info ${JSON.stringify(body)} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function fetchPerpDexs(): Promise<string[]> {
  const dexes = await infoPost<(PerpDex | null)[]>({ type: 'perpDexs' });
  return dexes
    .filter((d): d is PerpDex => d !== null && typeof d.name === 'string')
    .map(d => d.name);
}

async function fetchMetaAndAssetCtxs(dex?: string): Promise<[HyperliquidMeta, HyperliquidAssetCtx[]]> {
  const body: Record<string, string> = { type: 'metaAndAssetCtxs' };
  if (dex) body.dex = dex;
  return infoPost<[HyperliquidMeta, HyperliquidAssetCtx[]]>(body);
}

function dayVolume(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const volume = Number(value);
  return Number.isFinite(volume) ? volume : undefined;
}

/** The sub-DEX a perp belongs to ("xyz" for "xyz:TSLA"), or null for the main exchange's perps and spot pairs. */
export function dexOf(exchangeSecurityId: string): string | null {
  const colonIdx = exchangeSecurityId.indexOf(':');
  return colonIdx >= 0 ? exchangeSecurityId.slice(0, colonIdx) : null;
}

function perpFromAsset(
  asset: HyperliquidAsset,
  ctx: HyperliquidAssetCtx | undefined,
  settleCurrency: string,
): ExchangeSecurityData {
  const exchangeSecuritySymbol = asset.name;
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
    minNotional: PERPS_MIN_NOTIONAL * 1e9,
    contractMultiplier: CONTRACT_MULTIPLIER,
    active: asset.isDelisted !== true,
    volume24h: dayVolume(ctx?.dayNtlVlm),
  };
}

export class HyperliquidAdapter implements ExchangeAdapter {
  async fetchSecurities(): Promise<ExchangeFetch> {
    const [[mainMeta, mainCtxs], [spot, spotCtxs], dexNames] = await Promise.all([
      fetchMetaAndAssetCtxs(),
      infoPost<[HyperliquidSpotMeta, HyperliquidSpotCtx[]]>({ type: 'spotMetaAndAssetCtxs' }),
      fetchPerpDexs(),
    ]);

    const resolveSettle = (collateralToken: number): string =>
      spot.tokens[collateralToken]?.name ?? 'USDC';

    const result: ExchangeSecurityData[] = [];

    // A perp's context sits at its asset's index in the universe.
    const mainSettle = resolveSettle(mainMeta.collateralToken);
    mainMeta.universe.forEach((asset, i) => result.push(perpFromAsset(asset, mainCtxs[i], mainSettle)));

    // A spot pair's context names its pair; there are more contexts than pairs.
    const spotVolumeByPair = new Map<string, number | undefined>(
      spotCtxs.map(ctx => [ctx.coin, dayVolume(ctx.dayNtlVlm)]));
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
        feeGroup: 'spot',
        active: true,
        volume24h: spotVolumeByPair.get(pair.name),
      });
    }

    const failedDexes = new Set<string>();
    const dexResults = await Promise.allSettled(dexNames.map(name => fetchMetaAndAssetCtxs(name)));
    for (let i = 0; i < dexResults.length; i++) {
      const dexResult = dexResults[i];
      if (dexResult.status === 'rejected') {
        console.warn(`Hyperliquid: failed to fetch meta for DEX "${dexNames[i]}":`, dexResult.reason);
        failedDexes.add(dexNames[i]);
        continue;
      }
      const [meta, ctxs] = dexResult.value;
      const dexSettle = resolveSettle(meta.collateralToken);
      meta.universe.forEach((asset, j) => result.push(perpFromAsset(asset, ctxs[j], dexSettle)));
    }

    return {
      securities: result,
      // A DEX no longer in perpDexs is covered: its perps are gone with it.
      covers: (exchangeSecurityId) => {
        const dex = dexOf(exchangeSecurityId);
        return dex === null || !failedDexes.has(dex);
      },
    };
  }
}
