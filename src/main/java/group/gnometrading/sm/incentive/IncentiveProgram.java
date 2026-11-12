package group.gnometrading.sm.incentive;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One version of a venue incentive program (sm.incentive_program): the terms that held from {@code effectiveFromNanos}
 * until the program's next version. The program pays {@code reward} (price units, 1e9 = $1) per period or per day
 * between {@code periodStartNanos} and {@code periodEndNanos} (exclusive). {@code definition} holds the venue's own
 * scoring terms, which that venue's scorer reads.
 */
public record IncentiveProgram(
        String venueProgramId,
        IncentiveKind program,
        String venueMarket,
        long periodStartNanos,
        long periodEndNanos,
        long reward,
        RewardPer rewardPer,
        JsonNode definition,
        Boolean paidOut,
        long effectiveFromNanos) {

    /** A period's end when the program has none. */
    public static final long OPEN_ENDED = Long.MAX_VALUE;

    public enum IncentiveKind {
        LIQUIDITY
    }

    public enum RewardPer {
        PERIOD,
        DAY
    }

    /** True when {@code nanos} falls in the program's period. A cancelled program's period is empty. */
    public boolean covers(final long nanos) {
        return nanos >= this.periodStartNanos && nanos < this.periodEndNanos;
    }
}
