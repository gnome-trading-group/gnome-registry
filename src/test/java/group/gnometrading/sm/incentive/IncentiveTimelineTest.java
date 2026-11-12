package group.gnometrading.sm.incentive;

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import java.util.List;
import org.junit.jupiter.api.Test;

class IncentiveTimelineTest {

    private static IncentiveProgram version(final long effectiveFrom, final long start, final long end) {
        return new IncentiveProgram(
                "k1",
                IncentiveProgram.IncentiveKind.LIQUIDITY,
                "KXRT-VIO-60",
                start,
                end,
                100_000_000_000L,
                IncentiveProgram.RewardPer.PERIOD,
                JsonNodeFactory.instance.objectNode(),
                false,
                effectiveFrom);
    }

    @Test
    void aProgramPaysOnlyInsideTheVersionInEffect() {
        final IncentiveProgram announced = version(50, 100, 200);
        final IncentiveTimeline timeline =
                new IncentiveTimeline(List.<IncentiveProgram[]>of(new IncentiveProgram[] {announced}));

        assertNull(timeline.inForce(0, 99));
        assertSame(announced, timeline.inForce(0, 100));
        assertSame(announced, timeline.inForce(0, 199));
        assertNull(timeline.inForce(0, 200));
        assertNull(timeline.versionAt(0, 49));
    }

    @Test
    void aCancellationStopsTheProgramFromWhenItTookEffect() {
        final IncentiveProgram announced = version(50, 100, 200);
        // Kalshi cancels by moving the end before the start.
        final IncentiveProgram cancelled = version(80, 100, 80);
        final IncentiveTimeline timeline =
                new IncentiveTimeline(List.<IncentiveProgram[]>of(new IncentiveProgram[] {announced, cancelled}));

        assertSame(cancelled, timeline.versionAt(0, 150));
        assertNull(timeline.inForce(0, 150));
    }

    @Test
    void aChangeOfTermsMidPeriodAppliesFromWhenItTookEffect() {
        final IncentiveProgram first = version(0, 100, 200);
        final IncentiveProgram raised = version(150, 100, 200);
        final IncentiveTimeline timeline =
                new IncentiveTimeline(List.<IncentiveProgram[]>of(new IncentiveProgram[] {first, raised}));

        assertSame(first, timeline.inForce(0, 149));
        assertSame(raised, timeline.inForce(0, 150));
    }

    @Test
    void refusesVersionsOutOfOrder() {
        assertThrows(
                IllegalArgumentException.class,
                () -> new IncentiveTimeline(List.<IncentiveProgram[]>of(
                        new IncentiveProgram[] {version(80, 100, 200), version(50, 100, 200)})));
    }
}
