import { AssetClass, ContractType, ExchangeAdapter, ExchangeFetch, ExchangeSecurityData, SecurityType } from './types';

const LIGHTER_MARKETS_URL = 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails';
const LIGHTER_QUOTE_CURRENCY = 'USDC';
const CONTRACT_MULTIPLIER = 1_000_000_000;

interface LighterMarket {
  market_id: number;
  symbol: string; // base asset symbol, e.g. "ETH"
  price_decimals: number;
  size_decimals: number;
  min_quote_amount: string;
  status?: string;
  daily_quote_token_volume?: number;
}

interface LighterMarketsResponse {
  order_book_details: LighterMarket[];
  spot_order_book_details: LighterMarket[];
}

export class LighterAdapter implements ExchangeAdapter {
  async fetchSecurities(): Promise<ExchangeFetch> {
    const res = await fetch(LIGHTER_MARKETS_URL);
    if (!res.ok) {
      throw new Error(`Lighter orderBookDetails failed: ${res.status}`);
    }
    const data = (await res.json()) as LighterMarketsResponse;

    const result: ExchangeSecurityData[] = [];

    const processMarkets = (markets: LighterMarket[], isSpot: boolean) => {
      for (const market of markets ?? []) {
        if (!market.symbol) {
          console.warn(`Lighter: market_id=${market.market_id} missing symbol — skipping`);
          continue;
        }

        const tickSize = market.price_decimals > 9
          ? (console.warn(`Lighter: market ${market.market_id} price_decimals=${market.price_decimals} exceeds PRICE_SCALING_FACTOR (1e9) — storing tickSize=0`), 0)
          : Math.pow(10, 9 - market.price_decimals);
        const lotSize = market.size_decimals > 6
          ? (console.warn(`Lighter: market ${market.market_id} size_decimals=${market.size_decimals} exceeds SIZE_SCALING_FACTOR (1e6) — storing lotSize=0`), 0)
          : Math.pow(10, 6 - market.size_decimals);
        const minNotional = Math.round(parseFloat(market.min_quote_amount) * 1e9);
        const suffix = isSpot ? 'SPOT' : 'PERP';

        // Spot symbols are full pairs like "ETH/USDC"; perp symbols are just the base like "ETH"
        const slashIdx = market.symbol.indexOf('/');
        const baseCurrency = slashIdx >= 0 ? market.symbol.slice(0, slashIdx) : market.symbol;
        const quoteCurrency = slashIdx >= 0 ? market.symbol.slice(slashIdx + 1) : LIGHTER_QUOTE_CURRENCY;

        result.push({
          baseCurrency,
          quoteCurrency,
          settleCurrency: quoteCurrency,
          securitySymbol: `${baseCurrency}-${quoteCurrency}-${suffix}`,
          securityType: isSpot ? SecurityType.SPOT : SecurityType.PERPETUAL,
          contractType: isSpot ? ContractType.NONE : ContractType.LINEAR_PERPETUAL,
          assetClass: AssetClass.CRYPTO,
          inverse: false,
          isQuanto: false,
          exchangeSecurityId: String(market.market_id),
          exchangeSecuritySymbol: market.symbol,
          tickSize,
          lotSize,
          minNotional,
          contractMultiplier: CONTRACT_MULTIPLIER,
          active: market.status === 'active',
          volume24h: Number.isFinite(market.daily_quote_token_volume) ? market.daily_quote_token_volume : undefined,
        });
      }
    };

    processMarkets(data.order_book_details, false);
    processMarkets(data.spot_order_book_details, true);

    // One call returns every market, so a market missing from it is gone.
    return { securities: result, covers: () => true };
  }
}
