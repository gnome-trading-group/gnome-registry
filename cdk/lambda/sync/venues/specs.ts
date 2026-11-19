import { PriceBand } from '../../endpoints/price-bands';

// A listing's spec as its venue publishes it, in the registry's units: prices 1e9 per dollar, sizes 1e6 per unit.
export interface VenueSpec {
  priceBands: PriceBand[];
  lotSize: number;
  minNotional: number;
  minSize: number;
  contractMultiplier: number;
}

/** Reads the specs of these listings (by exchange security id) from the venue; one it doesn't know is left out. */
export type ReadSpecs = (exchangeSecurityIds: string[]) => Promise<Map<string, VenueSpec>>;

export const PRICE_SCALE = 1_000_000_000;
export const SIZE_SCALE = 1_000_000;

/** A binary contract's price bands in its complement's prices (1 - p), as its other side trades. */
export function complementBands(bands: PriceBand[]): PriceBand[] {
  return bands.slice().reverse().map(({ start, end, step }) => {
    if (end === null) throw new Error('A grid with no end has no complement');
    return { start: PRICE_SCALE - end, end: PRICE_SCALE - start, step };
  });
}

/** A venue decimal string or number in integer units of `scale`, or null when it isn't one. */
export function units(value: unknown, scale: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * scale);
}

/** Whether two specs are the same, band for band. */
export function sameSpec(a: VenueSpec, b: VenueSpec): boolean {
  return a.lotSize === b.lotSize && a.minNotional === b.minNotional && a.minSize === b.minSize
    && a.contractMultiplier === b.contractMultiplier && a.priceBands.length === b.priceBands.length
    && a.priceBands.every((band, i) => band.start === b.priceBands[i].start
      && band.end === b.priceBands[i].end && band.step === b.priceBands[i].step);
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
