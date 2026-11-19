// The queue POST /listing-specs/refresh puts a listing a shard saw change on, which the spec sync (SpecSyncStack) reads;
// by name, so the API stack needn't depend on the stack that owns it.
export const SPEC_REFRESH_QUEUE = 'listing-spec-refresh.fifo';

// The exchanges the spec sync has a reader for (its READERS), so the endpoint refuses a notice it could never act on
// without bundling every venue reader.
export const SPEC_SYNC_EXCHANGES = ['KALSHI', 'POLYMARKET_INTL', 'POLYMARKET_US', 'HYPERLIQUID', 'LIGHTER'];
