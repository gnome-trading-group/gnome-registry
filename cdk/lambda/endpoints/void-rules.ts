import { PRICE_SCALE } from './ledger-math';

// What each prediction venue pays when a market is voided: cancelled, a walkover, a postponement past its backstop.
// Equivalent contracts can then settle differently on different venues, which no outcome world shows.
//   POLYMARKET_INTL  50/50: every outcome pays $0.50
//   KALSHI           the last fair market price, which a position's current mark stands in for
//   POLYMARKET_US    the last fair market price (and $0.50 on a tie), as Kalshi
export type VoidRule = { kind: 'FIXED'; price: bigint } | { kind: 'MARK' };

const VOID_RULES: Record<string, VoidRule> = {
  POLYMARKET_INTL: { kind: 'FIXED', price: PRICE_SCALE / 2n },
  KALSHI: { kind: 'MARK' },
  POLYMARKET_US: { kind: 'MARK' },
};

export function voidRule(exchangeCode: string | null): VoidRule | null {
  return exchangeCode === null ? null : VOID_RULES[exchangeCode] ?? null;
}

export function sameVoidRule(a: VoidRule | null, b: VoidRule | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === 'MARK' || a.price === (b as { price: bigint }).price;
}
