import { ExchangeAdapter } from './types';
import { HyperliquidAdapter } from './hyperliquid';
import { LighterAdapter } from './lighter';

const adapters: Record<string, ExchangeAdapter> = {
  hyperliquid: new HyperliquidAdapter(),
  lighter: new LighterAdapter(),
};

export function getAdapter(exchangeName: string): ExchangeAdapter | undefined {
  return adapters[exchangeName.toLowerCase()];
}
