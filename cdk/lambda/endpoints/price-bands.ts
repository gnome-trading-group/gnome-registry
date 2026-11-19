import { ValidationError } from './base';

/** One band of a listing's price grid, in price units (1e9 = $1): prices in [start, end) step by step; end null is open. */
export interface PriceBand {
  start: number;
  end: number | null;
  step: number;
}

export const MAX_PRICE_BANDS = 16;

/**
 * The bands as a listing spec stores them, or a ValidationError saying what is wrong. The same rules as the Java client's
 * PriceGrid: contiguous from 0, positive steps, every edge on the steps beside it, only the last band open.
 */
export function validatePriceBands(value: unknown): PriceBand[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRICE_BANDS) {
    throw new ValidationError(`priceBands must be an array of 1 to ${MAX_PRICE_BANDS} bands`);
  }
  const bands = value.map((band, i) => readBand(band, i));
  if (bands[0].start !== 0) {
    throw new ValidationError(`priceBands must start at 0, not ${bands[0].start}`);
  }
  bands.forEach((band, i) => {
    const last = i === bands.length - 1;
    if (!last && band.end !== bands[i + 1].start) {
      throw new ValidationError(`priceBands[${i}] ends at ${band.end} but the next starts at ${bands[i + 1].start}`);
    }
    if (band.end !== null && band.end <= band.start) {
      throw new ValidationError(`priceBands[${i}] ends at ${band.end}, not after ${band.start}`);
    }
    if (band.start % band.step !== 0 || (band.end !== null && band.end % band.step !== 0)) {
      throw new ValidationError(`priceBands[${i}] has an edge off its step ${band.step}`);
    }
  });
  const end = bands[bands.length - 1].end;
  if (end !== null && bands.some(band => end % band.step !== 0)) {
    throw new ValidationError(`priceBands ending at ${end} must end on every band's step, so the grid mirrors`);
  }
  return bands;
}

/** A binary contract's price; its grid ends here, which readers mirror the other side about and treat as the cap. */
export const BINARY_GRID_END = 1_000_000_000;

/**
 * A ValidationError unless the grid ends where the listing's prices do: exactly $1 for a binary contract, open for
 * anything else, which has no upper bound.
 */
export function checkGridEnd(listingId: number, bands: PriceBand[], binary: boolean): void {
  const end = bands[bands.length - 1].end;
  if (binary && end !== BINARY_GRID_END) {
    throw new ValidationError(`listing ${listingId} is a binary contract: its price grid must end at ${BINARY_GRID_END}, `
      + `not ${end ?? 'open'}`);
  }
  if (!binary && end !== null) {
    throw new ValidationError(`listing ${listingId} has no upper price bound: its price grid must end open, not at ${end}`);
  }
}

function readBand(band: unknown, i: number): PriceBand {
  const { start, end, step } = (band ?? {}) as Record<string, unknown>;
  if (!isUnits(start) || !(end === null || isUnits(end)) || !isUnits(step) || step <= 0) {
    throw new ValidationError(`priceBands[${i}] must be {start, end, step} in whole price units, a positive step`);
  }
  return { start, end, step };
}

function isUnits(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One band from 0 stepping step to end (null for none): a listing with a single tick. */
export function singleBand(step: number, end: number | null): PriceBand[] {
  return [{ start: 0, end, step }];
}
