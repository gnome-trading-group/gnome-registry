import { PriceBand } from '../../endpoints/price-bands';
import { VenueSpec } from './specs';
import { AssetClass, ContractType, ExchangeAdapter, ExchangeFetch, ExchangeSecurityData, SecurityType } from './exchange-types';

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const PERPS_MAX_DECIMALS = 6;
const SPOT_MAX_DECIMALS = 8;
const CONTRACT_MULTIPLIER = 1_000_000_000;
const PERPS_MIN_NOTIONAL = 10;
const PRICE_DIGITS = 9;
const SIZE_DIGITS = 6;
// A price has at most this many significant figures, though a whole-dollar price is always allowed.
const SIGNIFICANT_FIGURES = 5;
// Outcome contracts (classifier listings `#<outcome><side>`) price 0 to 1 in thousandths, one share at a time.
const OUTCOME_SPEC: VenueSpec = {
  priceBands: [{ start: 0, end: 1_000_000_000, step: 1_000_000 }],
  lotSize: 1_000_000,
  minNotional: 0,
  minSize: 0,
  contractMultiplier: CONTRACT_MULTIPLIER,
};

const unitsOf = (digits: number) => Math.pow(10, digits);

/**
 * A market's price grid: at most 5 significant figures and at most maxDecimals - szDecimals decimals, and a whole
 * dollar always allowed. So the step is the decimals' below 10^(5 - decimals) dollars, grows tenfold each decade above
 * that, and stays $1 from $10,000 up. Null when the finest step is below a price unit (1e-9 dollars).
 */
export function hyperliquidPriceBands(maxDecimals: number, szDecimals: number): PriceBand[] | null {
  const decimals = maxDecimals - szDecimals;
  if (decimals > PRICE_DIGITS || decimals < 0) return null;
  const dollar = unitsOf(PRICE_DIGITS);
  const wholeFrom = SIGNIFICANT_FIGURES - 1;
  const firstDecade = SIGNIFICANT_FIGURES - decimals;
  if (firstDecade > wholeFrom) return [{ start: 0, end: null, step: dollar }];
  const bands: PriceBand[] = [{ start: 0, end: unitsOf(PRICE_DIGITS + firstDecade), step: unitsOf(PRICE_DIGITS - decimals) }];
  for (let decade = firstDecade; decade < wholeFrom; decade++) {
    bands.push({
      start: unitsOf(PRICE_DIGITS + decade),
      end: unitsOf(PRICE_DIGITS + decade + 1),
      step: unitsOf(PRICE_DIGITS + decade - wholeFrom),
    });
  }
  bands.push({ start: unitsOf(PRICE_DIGITS + wholeFrom), end: null, step: dollar });
  return bands;
}

function hyperliquidSpec(maxDecimals: number, szDecimals: number, minNotional: number): VenueSpec | null {
  const priceBands = hyperliquidPriceBands(maxDecimals, szDecimals);
  if (!priceBands || szDecimals > SIZE_DIGITS) return null;
  return {
    priceBands,
    lotSize: unitsOf(SIZE_DIGITS - szDecimals),
    minNotional,
    minSize: 0,
    contractMultiplier: CONTRACT_MULTIPLIER,
  };
}

/** The spec of a Hyperliquid listing the exchange sync doesn't fetch: an outcome contract, or null for anything else. */
export function hyperliquidOutcomeSpec(exchangeSecurityId: string): VenueSpec | null {
  return exchangeSecurityId.startsWith('#') ? OUTCOME_SPEC : null;
}

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
  index: number;
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
    spec: hyperliquidSpec(PERPS_MAX_DECIMALS, asset.szDecimals, PERPS_MIN_NOTIONAL * unitsOf(PRICE_DIGITS)),
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

    // Pairs and collateral name tokens by their index, which isn't their place in the list: the list has gaps.
    const tokens = new Map(spot.tokens.map(token => [token.index, token]));
    const resolveSettle = (collateralToken: number): string =>
      tokens.get(collateralToken)?.name ?? 'USDC';

    const result: ExchangeSecurityData[] = [];

    // A perp's context sits at its asset's index in the universe.
    const mainSettle = resolveSettle(mainMeta.collateralToken);
    mainMeta.universe.forEach((asset, i) => result.push(perpFromAsset(asset, mainCtxs[i], mainSettle)));

    // A spot pair's context names its pair; there are more contexts than pairs.
    const spotVolumeByPair = new Map<string, number | undefined>(
      spotCtxs.map(ctx => [ctx.coin, dayVolume(ctx.dayNtlVlm)]));
    for (const pair of spot.universe) {
      const baseToken = tokens.get(pair.tokens[0]);
      const quoteToken = tokens.get(pair.tokens[1]);
      if (!baseToken || !quoteToken) continue;

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
        spec: hyperliquidSpec(SPOT_MAX_DECIMALS, baseToken.szDecimals, 0),
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

/** Specs for Hyperliquid listings: perps and spot from the venue's metadata, outcome contracts by rule. */
export async function readHyperliquidSpecs(exchangeSecurityIds: string[]): Promise<Map<string, VenueSpec>> {
  const specs = new Map<string, VenueSpec>();
  const wanted = new Set<string>();
  for (const id of exchangeSecurityIds) {
    const outcome = hyperliquidOutcomeSpec(id);
    if (outcome) specs.set(id, outcome);
    else wanted.add(id);
  }
  if (wanted.size === 0) return specs;
  for (const security of (await new HyperliquidAdapter().fetchSecurities()).securities) {
    if (security.spec && wanted.has(security.exchangeSecurityId)) specs.set(security.exchangeSecurityId, security.spec);
  }
  return specs;
}
