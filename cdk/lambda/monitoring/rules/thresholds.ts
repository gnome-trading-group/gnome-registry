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
