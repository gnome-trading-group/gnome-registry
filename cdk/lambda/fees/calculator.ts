import { IFeeDefinition } from './definition';

// A fill's fee as the venue charges it, matching gnome-registry's Java FeeSchedule and gnomepy's fees.py exactly: the
// components are computed in floating point, snapped to 1e-12 dollars, then rounded in integers. Prices and fees are
// price units (1e9 = $1) and quantities size units (1e6 = 1 contract), as bigints.

const PRICE_SCALE = 1_000_000_000;
const SIZE_SCALE = 1_000_000;
const PICO_PER_UNIT = 1_000n;
// Kalshi's model fee rounds up to $0.000001 before balance rounding.
const MICRO_DOLLAR_PICO = 1_000_000n;

/** What one order carries from fill to fill for ORDER_ACCUMULATOR rounding. */
export interface OrderFeeState {
  accumulatedUnits: bigint;
}

export function newOrderFeeState(): OrderFeeState {
  return { accumulatedUnits: 0n };
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

function halfAwayFromZero(value: bigint, divisor: bigint): bigint {
  const magnitude = value < 0n ? -value : value;
  const steps = (magnitude + divisor / 2n) / divisor;
  return value < 0n ? -steps : steps;
}

function halfEven(value: bigint, divisor: bigint): bigint {
  const quotient = floorDiv(value, divisor);
  const twiceRemainder = 2n * (value - quotient * divisor);
  if (twiceRemainder > divisor || (twiceRemainder === divisor && (quotient & 1n) !== 0n)) return quotient + 1n;
  return quotient;
}

export class FeeCalculator {
  private readonly increment: bigint;

  constructor(private readonly definition: IFeeDefinition) {
    const r = definition.rounding;
    this.increment = r.mode === 'NONE' ? 0n : BigInt(Math.round((r.increment as number) * PRICE_SCALE));
  }

  /**
   * The fee for one fill, rounded as the venue rounds it. `state` carries an order's rounding from fill to fill for
   * ORDER_ACCUMULATOR; pass the same object for every fill of an order, or none for a lone fill.
   */
  fee(buy: boolean, price: bigint, qty: bigint, maker: boolean, state?: OrderFeeState): bigint {
    const pico = this.rawPico(buy, price, qty, maker);
    if (this.definition.rounding.scope === 'ORDER_ACCUMULATOR') return this.accumulate(buy, price, qty, pico, state);
    return this.roundFill(pico);
  }

  rawPico(buy: boolean, price: bigint, qty: bigint, maker: boolean): bigint {
    const contracts = Number(qty) / SIZE_SCALE;
    const priceUnits = Number(price);
    let units = 0;
    for (const c of this.definition.components) {
      if (c.side !== undefined && (c.side === 'BUY') !== buy) continue;
      const rate = maker ? c.maker : c.taker;
      if (rate === 0) continue;
      if (c.kind === 'PRICE_CURVE') {
        const p = priceUnits / PRICE_SCALE;
        const shape = p * (1.0 - p);
        const exponent = c.exponent ?? 1;
        units += rate * contracts * (exponent === 1 ? shape : Math.pow(shape, exponent)) * PRICE_SCALE;
      } else if (c.kind === 'NOTIONAL') {
        units += rate * contracts * priceUnits;
      } else {
        units += rate * contracts * PRICE_SCALE;
      }
    }
    return BigInt(Math.floor(units * Number(PICO_PER_UNIT) + 0.5));
  }

  roundFill(pico: bigint): bigint {
    const mode = this.definition.rounding.mode;
    // Toward zero, as Java's integer division.
    if (mode === 'NONE') return pico / PICO_PER_UNIT;
    const increment = this.increment * PICO_PER_UNIT;
    const steps = mode === 'CEIL' ? ceilDiv(pico, increment)
      : mode === 'HALF_UP' ? halfAwayFromZero(pico, increment)
        : halfEven(pico, increment);
    return steps * this.increment;
  }

  private accumulate(buy: boolean, price: bigint, qty: bigint, pico: bigint, state?: OrderFeeState): bigint {
    const increment = this.increment;
    const tradeFee = ceilDiv(pico, MICRO_DOLLAR_PICO) * (MICRO_DOLLAR_PICO / PICO_PER_UNIT);
    const notional = (price * qty) / BigInt(SIZE_SCALE);
    const change = (buy ? -notional : notional) - tradeFee;
    const roundingFee = change - floorDiv(change, increment) * increment;
    const gross = tradeFee + roundingFee;
    const accumulated = (state?.accumulatedUnits ?? 0n) + roundingFee;
    const byAccumulated = floorDiv(accumulated, increment) * increment;
    const byGross = floorDiv(gross, increment) * increment;
    const rebate = byAccumulated < byGross ? byAccumulated : byGross;
    if (state) state.accumulatedUnits = accumulated - rebate;
    return gross - rebate;
  }
}
