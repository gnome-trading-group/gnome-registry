package group.gnometrading.sm.fee;

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class FeeTimelineTest {

    private static FeeSchedule schedule(final double taker) {
        return new FeeSchedule(
                "USD",
                new FeeComponent[] {new FeeComponent(FeeKind.PRICE_CURVE, taker, 0, 1, FeeSide.BOTH)},
                FeeRounding.NONE);
    }

    private final FeeSchedule first = schedule(0.05);
    private final FeeSchedule second = schedule(0.06);
    private final FeeTimeline timeline = new FeeTimeline(
            new long[] {100, 300}, new long[] {200, FeeTimeline.OPEN_ENDED}, new FeeSchedule[] {first, second});

    @Test
    void eachEntryHoldsFromItsStartUntilItsEnd() {
        assertSame(first, timeline.at(100));
        assertSame(first, timeline.at(199));
        assertSame(second, timeline.at(300));
        assertSame(second, timeline.at(Long.MAX_VALUE - 1));
    }

    @Test
    void timesNoEntryCoversHaveNoFees() {
        assertNull(timeline.at(99));
        assertNull(timeline.at(200));
        assertNull(timeline.at(299));
        assertNull(FeeTimeline.EMPTY.at(0));
    }

    @Test
    void entriesMustBeOrderedWithoutOverlap() {
        assertThrows(
                IllegalArgumentException.class,
                () -> new FeeTimeline(new long[] {100, 150}, new long[] {200, 300}, new FeeSchedule[] {first, second}));
    }
}
