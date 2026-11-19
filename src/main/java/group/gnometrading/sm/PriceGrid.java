package group.gnometrading.sm;

import java.util.Arrays;

/**
 * The prices a listing may trade at: contiguous bands from 0, each with its own step, up to an end (1e9 for a binary
 * contract, open otherwise). A listing with one tick is one band. Every inner band edge is a multiple of the steps on
 * both sides of it, so which band owns an edge never matters and the grid mirrors exactly.
 *
 * <p>Grid points are 0, every multiple of a band's step inside that band, and the end. A valid price is a grid point
 * strictly between 0 and the end. {@link #floor}, {@link #ceil}, {@link #up} and {@link #down} answer grid points,
 * which can be 0 or the end at the edges; bound them with {@link #min()} and {@link #max()} where a valid price is
 * needed. Lookups never allocate.
 */
public final class PriceGrid {

    /** The end of a grid with no upper bound. */
    public static final long OPEN = Long.MAX_VALUE;

    public static final int MAX_BANDS = 16;

    private final long[] starts;
    private final long[] steps;
    private final long end;

    private PriceGrid(final long[] starts, final long[] steps, final long end) {
        this.starts = starts;
        this.steps = steps;
        this.end = end;
    }

    /** One step from 0 to {@code end} ({@link #OPEN} for none). */
    public static PriceGrid single(final long step, final long end) {
        return of(new long[] {0}, new long[] {end}, new long[] {step});
    }

    /**
     * The grid of bands {@code [starts[i], ends[i])} stepping {@code steps[i]}; the last end may be {@link #OPEN}.
     *
     * @throws IllegalArgumentException unless the bands start at 0, follow on without gaps or overlaps, have positive
     *     steps, and every edge sits on the steps on both sides of it
     */
    public static PriceGrid of(final long[] starts, final long[] ends, final long[] steps) {
        final int bands = starts.length;
        if (bands == 0 || bands > MAX_BANDS || ends.length != bands || steps.length != bands) {
            throw new IllegalArgumentException("A grid has 1 to " + MAX_BANDS + " bands, each a start, end and step");
        }
        if (starts[0] != 0) {
            throw new IllegalArgumentException("A grid starts at 0, not " + starts[0]);
        }
        for (int i = 0; i < bands; i++) {
            checkBand(i, starts[i], ends[i], steps[i]);
            if (i + 1 < bands && ends[i] != starts[i + 1]) {
                throw new IllegalArgumentException(
                        "Band " + i + " ends at " + ends[i] + " but the next starts at " + starts[i + 1]);
            }
        }
        final long end = ends[bands - 1];
        checkEnd(end, steps);
        return new PriceGrid(starts.clone(), steps.clone(), end);
    }

    // A closed grid ends on every band's step, so mirroring it about its end lands every edge on a step.
    private static void checkEnd(final long end, final long[] steps) {
        if (end == OPEN) {
            return;
        }
        for (final long step : steps) {
            if (end % step != 0) {
                throw new IllegalArgumentException(
                        "A grid ending at " + end + " must end on every band's step, not " + step);
            }
        }
    }

    private static void checkBand(final int band, final long start, final long end, final long step) {
        if (step <= 0) {
            throw new IllegalArgumentException("Band " + band + " has step " + step);
        }
        if (end <= start) {
            throw new IllegalArgumentException("Band " + band + " ends at " + end + ", not after " + start);
        }
        if (start % step != 0 || (end != OPEN && end % step != 0)) {
            throw new IllegalArgumentException(
                    "Band " + band + " [" + start + ", " + end + ") has an edge off its step " + step);
        }
    }

    public int bands() {
        return this.starts.length;
    }

    public long start(final int band) {
        return this.starts[band];
    }

    public long bandEnd(final int band) {
        return band + 1 < this.starts.length ? this.starts[band + 1] : this.end;
    }

    public long step(final int band) {
        return this.steps[band];
    }

    /** The grid's end: 1e9 for a binary contract, {@link #OPEN} when it has none. */
    public long end() {
        return this.end;
    }

    /** Whether {@code price} is a grid point strictly between 0 and the end. */
    public boolean valid(final long price) {
        return price > 0 && price < this.end && price % this.steps[band(price)] == 0;
    }

    /** The highest grid point at or below {@code price}: 0 below the first step, the end at or past it. */
    public long floor(final long price) {
        if (price <= 0) {
            return 0;
        }
        if (price >= this.end) {
            return this.end;
        }
        return price - price % this.steps[band(price)];
    }

    /** The lowest grid point at or above {@code price}: 0 at or below 0, the end past the last band's last step. */
    public long ceil(final long price) {
        if (price <= 0) {
            return 0;
        }
        if (price >= this.end) {
            return this.end;
        }
        final long step = this.steps[band(price)];
        final long below = price - price % step;
        if (below == price) {
            return price;
        }
        // Compared before adding, so a price near the top of an open grid can't overflow past it.
        return step >= this.end - below ? this.end : below + step;
    }

    /** The grid point {@code steps} steps above {@code price}, each step the one in force there; never past the end. */
    public long up(final long price, final int steps) {
        long at = price;
        for (int i = 0; i < steps && at < this.end; i++) {
            at = ceil(at + 1);
        }
        return at;
    }

    /** The grid point {@code steps} steps below {@code price}; a step down from a band's start takes the band below's. */
    public long down(final long price, final int steps) {
        long at = price;
        for (int i = 0; i < steps && at > 0; i++) {
            at = floor(at - 1);
        }
        return at;
    }

    /** How many grid steps lie between two prices, counted from each one's floor and across bands. */
    public long ticksBetween(final long from, final long to) {
        return Math.abs(index(to) - index(from));
    }

    /** The lowest valid price. */
    public long min() {
        return this.steps[0];
    }

    /** The highest valid price. */
    public long max() {
        final long last = this.steps[this.steps.length - 1];
        return this.end == OPEN ? OPEN - OPEN % last : this.end - last;
    }

    /** The smallest step anywhere on the grid. */
    public long finestStep() {
        long finest = this.steps[0];
        for (int i = 1; i < this.steps.length; i++) {
            finest = Math.min(finest, this.steps[i]);
        }
        return finest;
    }

    /** The grid in the complement's prices ({@code end - p}), as a binary contract's other side trades. */
    public PriceGrid complement() {
        if (this.end == OPEN) {
            throw new IllegalStateException("A grid with no end has no complement");
        }
        final int bands = this.starts.length;
        final long[] mirroredStarts = new long[bands];
        final long[] mirroredEnds = new long[bands];
        final long[] mirroredSteps = new long[bands];
        for (int i = 0; i < bands; i++) {
            final int from = bands - 1 - i;
            mirroredStarts[i] = this.end - bandEnd(from);
            mirroredEnds[i] = this.end - this.starts[from];
            mirroredSteps[i] = this.steps[from];
        }
        return of(mirroredStarts, mirroredEnds, mirroredSteps);
    }

    /** The band holding {@code price}, which is at least 0 and before the end. */
    private int band(final long price) {
        int band = this.starts.length - 1;
        while (this.starts[band] > price) {
            band--;
        }
        return band;
    }

    /** How many grid steps the floor of {@code price} is above 0. */
    private long index(final long price) {
        final long at = floor(price);
        long index = 0;
        for (int i = 0; i < this.starts.length; i++) {
            final long bandEnd = bandEnd(i);
            if (at < bandEnd || i + 1 == this.starts.length) {
                return index + (at - this.starts[i]) / this.steps[i];
            }
            index += (bandEnd - this.starts[i]) / this.steps[i];
        }
        return index;
    }

    @Override
    public boolean equals(final Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof PriceGrid grid)) {
            return false;
        }
        return this.end == grid.end && Arrays.equals(this.starts, grid.starts) && Arrays.equals(this.steps, grid.steps);
    }

    @Override
    public int hashCode() {
        return 31 * (31 * Arrays.hashCode(this.starts) + Arrays.hashCode(this.steps)) + Long.hashCode(this.end);
    }

    @Override
    public String toString() {
        final StringBuilder text = new StringBuilder();
        for (int i = 0; i < this.starts.length; i++) {
            final long bandEnd = bandEnd(i);
            text.append(i == 0 ? "" : " ")
                    .append('[')
                    .append(this.starts[i])
                    .append(',')
                    .append(bandEnd == OPEN ? "open" : Long.toString(bandEnd))
                    .append(")@")
                    .append(this.steps[i]);
        }
        return text.toString();
    }
}
