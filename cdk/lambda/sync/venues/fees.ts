import { IFeeDefinition } from '../../fees/definition';

/**
 * A fee schedule as a venue's history gives it: one target (a fee group or a fee event of the exchange), in force from
 * `effectiveFrom` until the target's next schedule. A null definition records the venue setting nothing there, so the
 * target falls through to the next scope.
 */
export interface VenueFeeSchedule {
  feeGroup?: string;
  feeEvent?: string;
  effectiveFrom: string;
  definition: IFeeDefinition | null;
  sourceRef: string;
  // The date is the venue's (its change log, or an announcement the reader lists), not when the sync first saw it.
  dated?: boolean;
}

/** A venue's fee history, and the fee types it charges by whose schedule couldn't be read. */
export interface VenueFeeRead {
  schedules: VenueFeeSchedule[];
  unreadable: string[];
}

/** A rate kept exact to 1e-10: 0.07 * 0.5 is 0.035000000000000004 in binary, and schedules are compared by value. */
export function feeRate(value: number): number {
  return Number(value.toFixed(10));
}

export function byEffectiveFrom<T extends { effectiveFrom: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom));
}
