package group.gnometrading.sm.fee;

/**
 * One listing's fee schedules over time, as the registry resolves them: each holds from its start until its end
 * (exclusive), and a time no entry covers has no known fees. Times are epoch nanoseconds. Never allocates.
 */
public final class FeeTimeline {

    /** An entry's end when it holds until further notice. */
    public static final long OPEN_ENDED = Long.MAX_VALUE;

    private static final long[] NO_TIMES = new long[0];
    private static final FeeSchedule[] NO_SCHEDULES = new FeeSchedule[0];

    public static final FeeTimeline EMPTY = new FeeTimeline(NO_TIMES, NO_TIMES, NO_SCHEDULES);

    private final long[] startNanos;
    private final long[] endNanos;
    private final FeeSchedule[] schedules;

    /** Entries in start order that don't overlap; {@code endNanos} of {@link #OPEN_ENDED} holds until further notice. */
    public FeeTimeline(final long[] startNanos, final long[] endNanos, final FeeSchedule[] schedules) {
        if (startNanos.length != endNanos.length || startNanos.length != schedules.length) {
            throw new IllegalArgumentException("A timeline needs a start, an end and a schedule for every entry");
        }
        for (int i = 0; i < startNanos.length; i++) {
            if (endNanos[i] <= startNanos[i] || (i > 0 && startNanos[i] < endNanos[i - 1])) {
                throw new IllegalArgumentException("Timeline entries must be ordered and must not overlap");
            }
        }
        this.startNanos = startNanos.clone();
        this.endNanos = endNanos.clone();
        this.schedules = schedules.clone();
    }

    /** The schedule in force at {@code nanos}, or null when no fees are known for that time. */
    public FeeSchedule at(final long nanos) {
        int low = 0;
        int high = this.startNanos.length - 1;
        while (low <= high) {
            final int mid = (low + high) >>> 1;
            if (this.startNanos[mid] <= nanos) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        if (high < 0 || nanos >= this.endNanos[high]) {
            return null;
        }
        return this.schedules[high];
    }

    public int size() {
        return this.schedules.length;
    }
}
