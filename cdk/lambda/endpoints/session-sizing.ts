// How a session is sized when its launch names no instance type: from its tier and the load its streams are predicted
// to bring, every stream at one busy listing's rate. The limits come from load ramps of paper sessions on each size.

export const TIERS = ['slow', 'standard', 'low_latency'] as const;
export type Tier = (typeof TIERS)[number];
export type LatencyProfile = 'standard' | 'low_latency';

/**
 * Records a second a stream is assumed to bring: a busy listing in its busiest hour (the 90th percentile across every
 * venue's listings), so most sessions are sized with room to spare.
 */
export const RECORDS_PER_SECOND_PER_STREAM = 20;

// t3.small (burstable, ~25% of its CPU stolen under load) held steady loads without loss but stalled on bursts, so it
// takes only a small session; c7a.medium (one whole core) held every load to 4,000 records/s; c7a.large past that.
export const SLOW_T3_MAX_RECORDS_PER_SECOND = 500;
export const STANDARD_MEDIUM_MAX_STREAMS = 100;
export const STANDARD_MEDIUM_MAX_RECORDS_PER_SECOND = 4000;
// A Python strategy spends ~0.4-0.5 ms a record on its one thread (a do-nothing one, on t3.small), so its budget is the
// strategy thread's, whatever the size: past ~1,000 records/s a one-core host has nothing left for the rest.
export const PYTHON_T3_MAX_RECORDS_PER_SECOND = 300;
export const PYTHON_MEDIUM_MAX_RECORDS_PER_SECOND = 1000;
// c7i.2xlarge matched c7i.4xlarge's market-data latency to 32,000 records/s and 200 streams, its order path a few µs
// slower; c7i.4xlarge stays for a session that needs those µs, named explicitly.
export const LOW_LATENCY_INSTANCE_TYPE = 'c7i.2xlarge';

export interface PredictedLoad {
  recordsPerSecond: number;
  streams: number;
}

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** The orchestrator's profile for a tier: only low latency isolates cores, so slow and standard share one. */
export function profileForTier(tier: Tier): LatencyProfile {
  return tier === 'low_latency' ? 'low_latency' : 'standard';
}

/** The tier a session launched with only a profile is sized as. */
export function tierForProfile(profile: LatencyProfile): Tier {
  return profile === 'low_latency' ? 'low_latency' : 'standard';
}

/** The load of a session reading {@code streams} streams, its listings' and its data-only ones. */
export function predictLoad(streams: number): PredictedLoad {
  return { recordsPerSecond: streams * RECORDS_PER_SECOND_PER_STREAM, streams };
}

export function defaultInstanceType(tier: Tier, load: PredictedLoad, python: boolean): string {
  if (tier === 'low_latency') return LOW_LATENCY_INSTANCE_TYPE;
  if (python) {
    if (tier === 'slow' && load.recordsPerSecond <= PYTHON_T3_MAX_RECORDS_PER_SECOND) return 't3.small';
    return load.recordsPerSecond <= PYTHON_MEDIUM_MAX_RECORDS_PER_SECOND
      && load.streams <= STANDARD_MEDIUM_MAX_STREAMS ? 'c7a.medium' : 'c7a.large';
  }
  if (tier === 'slow' && load.recordsPerSecond <= SLOW_T3_MAX_RECORDS_PER_SECOND) return 't3.small';
  return load.streams <= STANDARD_MEDIUM_MAX_STREAMS && load.recordsPerSecond <= STANDARD_MEDIUM_MAX_RECORDS_PER_SECOND
    ? 'c7a.medium'
    : 'c7a.large';
}
