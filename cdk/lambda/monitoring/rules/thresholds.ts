export const SILENT_AFTER_MS = 60_000;
// A session that says it's running but has never sent a heartbeat, this long after starting.
export const NO_HEARTBEAT_AFTER_MS = 120_000;
// A hot-path agent this long without a pass shows on the overview; the alert waits for it to last (see the catalog's
// debounce), so a GC pause is seen but doesn't page.
export const HOT_PATH_STALL_MS = 2_000;
export const FAILED_WITHIN_MS = 24 * 3_600_000;
export const NO_PRICE_AFTER_MS = 3_600_000;
// How long a deactivated prediction listing may hold a position with no settlement value before the classifier is
// suspected of missing it, and how long a settled one may stay open before the sweeper is.
export const SETTLEMENT_PENDING_AFTER_MS = 24 * 3_600_000;
export const SETTLEMENT_BOOKING_AFTER_MS = 15 * 60_000;
// Launch to first heartbeat covers EC2 boot, the AMI's setup and the JVM's startup and recovery; Python strategies
// install their dependencies on top.
export const START_STUCK_AFTER_MS = 15 * 60_000;
// A stop waits a few seconds then terminates the instance; the monitor marks it STOPPED once EC2 says it's gone.
export const STOP_STUCK_AFTER_MS = 10 * 60_000;
// Each bad-book resync forces a reconnect, and ten gateway errors a minute exit the session.
export const BOOK_RESYNCS_PER_5M = 3;
// A listing's book flagged bad data, so its OMS refuses new orders on it. A resync takes seconds; a minute is a feed
// that isn't coming back by itself, and five with a position held is risk nobody can trade out of.
export const MARKET_DATA_BAD_AFTER_MS = 60_000;
export const MARKET_DATA_BAD_HELD_AFTER_MS = 5 * 60_000;
// Orders with a fill in this window have their venue fees checked against the registry's schedules; a cent per order
// covers the one Polymarket US rounding we couldn't explain (2026-10-15).
export const FEE_LOOKBACK_MS = 24 * 3_600_000;
export const FEE_TOLERANCE_UNITS = 10_000_000n;
// Host readings from the heartbeat (gnome-core's HostReadings). CPU is in tenths of a percent of every core; stolen time
// is what a burstable instance out of CPU credits loses to throttling.
export const HOST_CPU_BUSY_PERMILLE = 900;
export const HOST_CPU_STEAL_PERMILLE = 200;
export const HOST_MEM_AVAILABLE_MIN_PERCENT = 10;
// A full disk crashes the session the next time the journal maps a segment; two segments' room leaves time to act.
export const DISK_FREE_MIN_BYTES = 1024 ** 3;
export const DISK_FREE_MIN_SEGMENTS = 2;
// The shipper uploads a segment within seconds of the minute it closes; three waiting, or one for five minutes, is a
// shipper that has stopped or can't reach S3.
export const JOURNAL_BACKLOG_SEGMENTS = 3;
export const JOURNAL_BACKLOG_AGE_MS = 5 * 60_000;
