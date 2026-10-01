import { ExchangeAdapter } from './types';
import { HyperliquidAdapter } from './hyperliquid';
import { LighterAdapter } from './lighter';

const adapters: Record<string, ExchangeAdapter> = {
  HYPERLIQUID: new HyperliquidAdapter(),
  LIGHTER: new LighterAdapter(),
};

export function getAdapter(exchangeCode: string): ExchangeAdapter | undefined {
  return adapters[exchangeCode];
}
