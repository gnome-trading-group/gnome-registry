package group.gnometrading.sm.fee;

import group.gnometrading.schemas.Statics;
import group.gnometrading.utils.ScaledMath;

/**
 * A venue's fee schedule for one listing over one stretch of time, as the registry stores it (sm.fee_schedule): a fill's
 * fee is the sum of its {@link FeeComponent}s, rounded by its {@link FeeRounding}. Prices and fees are in price units
 * (1e9 = $1) and quantities in size units (1e6 = 1 contract), as everywhere else. Never allocates.
 *
 * <p>The components are computed in floating point and snapped to 1e-12 dollars before rounding, so a fee that lands
 * exactly on a rounding boundary isn't pushed over it by binary error. That is exact for any fill under about $1,000 of
 * fee; above it the snap can differ from the venue's exact arithmetic by a picodollar.
 */
public final class FeeSchedule {

    private static final double PRICE_SCALE = Statics.PRICE_SCALING_FACTOR;
    private static final double PICO_PER_UNIT = 1_000.0;
    private static final long PICO_PER_UNIT_LONG = 1_000L;
    // Kalshi's model fee rounds up to $0.000001 before balance rounding.
    private static final long MICRO_DOLLAR_PICO = 1_000_000L;

    private final String currency;
    private final FeeComponent[] components;
    private final FeeRounding rounding;

    public FeeSchedule(final String currency, final FeeComponent[] components, final FeeRounding rounding) {
        if (rounding.scope() == FeeRounding.Scope.ORDER_ACCUMULATOR && rounding.mode() != FeeRounding.Mode.CEIL) {
            throw new IllegalArgumentException("ORDER_ACCUMULATOR rounding must be CEIL");
        }
        if (rounding.mode() != FeeRounding.Mode.NONE && rounding.incrementUnits() <= 0) {
            throw new IllegalArgumentException("Rounding needs a positive increment: " + rounding);
        }
        this.currency = currency;
        this.components = components.clone();
        this.rounding = rounding;
    }

    public String currency() {
        return this.currency;
    }

    public FeeRounding rounding() {
        return this.rounding;
    }

    /** A copy of the components, for callers outside the hot path (gnomepy reads them once per schedule). */
    public FeeComponent[] components() {
        return this.components.clone();
    }

    /**
     * The fee for one fill, rounded as the venue rounds it. {@code state} carries an order's rounding from fill to
     * fill for {@link FeeRounding.Scope#ORDER_ACCUMULATOR}; pass the same instance for every fill of an order, or null
     * to round the fill as if it were the order's only one.
     */
    public long fee(
            final boolean buy, final long price, final long qty, final boolean maker, final OrderFeeState state) {
        final long pico = rawPico(buy, price, qty, maker);
        if (this.rounding.scope() == FeeRounding.Scope.ORDER_ACCUMULATOR) {
            return accumulate(buy, price, qty, pico, state);
        }
        return roundFill(pico);
    }

    /**
     * The unrounded fee for one fill, in picodollars (1e-3 price units), for venues that sum a fill's parts before
     * rounding once ({@link #roundFill}).
     */
    public long rawPico(final boolean buy, final long price, final long qty, final boolean maker) {
        final double contracts = (double) qty / Statics.SIZE_SCALING_FACTOR;
        double units = 0;
        for (final FeeComponent component : this.components) {
            if (!component.side().applies(buy)) {
                continue;
            }
            final double rate = maker ? component.maker() : component.taker();
            if (rate == 0) {
                continue;
            }
            units += switch (component.kind()) {
                case PRICE_CURVE -> rate * contracts * curve(price, component.exponent()) * PRICE_SCALE;
                case NOTIONAL -> rate * contracts * price;
                case PER_UNIT -> rate * contracts * PRICE_SCALE;};
        }
        return Math.round(units * PICO_PER_UNIT);
    }

    /** Rounds an unrounded fee ({@link #rawPico}) to price units as one fill. */
    public long roundFill(final long pico) {
        if (this.rounding.mode() == FeeRounding.Mode.NONE) {
            return pico / PICO_PER_UNIT_LONG;
        }
        final long increment = this.rounding.incrementUnits() * PICO_PER_UNIT_LONG;
        final long steps =
                switch (this.rounding.mode()) {
                    case CEIL -> ceilDiv(pico, increment);
                    case HALF_UP -> halfAwayFromZero(pico, increment);
                    case HALF_EVEN -> halfEven(pico, increment);
                    case NONE -> throw new IllegalStateException();
                };
        return steps * this.rounding.incrementUnits();
    }

    private long accumulate(
            final boolean buy, final long price, final long qty, final long pico, final OrderFeeState state) {
        final long increment = this.rounding.incrementUnits();
        final long tradeFee = ceilDiv(pico, MICRO_DOLLAR_PICO) * (MICRO_DOLLAR_PICO / PICO_PER_UNIT_LONG);
        final long notional = ScaledMath.multiplyDivide(price, qty, Statics.SIZE_SCALING_FACTOR);
        final long change = (buy ? -notional : notional) - tradeFee;
        final long roundingFee = change - Math.floorDiv(change, increment) * increment;
        final long gross = tradeFee + roundingFee;
        final long accumulated = (state == null ? 0 : state.accumulatedUnits) + roundingFee;
        final long rebate = Math.min(
                Math.floorDiv(accumulated, increment) * increment, Math.floorDiv(gross, increment) * increment);
        if (state != null) {
            state.accumulatedUnits = accumulated - rebate;
        }
        return gross - rebate;
    }

    private static double curve(final long price, final double exponent) {
        final double p = price / PRICE_SCALE;
        final double shape = p * (1.0 - p);
        return exponent == 1.0 ? shape : Math.pow(shape, exponent);
    }

    private static long ceilDiv(final long value, final long divisor) {
        return -Math.floorDiv(-value, divisor);
    }

    private static long halfAwayFromZero(final long value, final long divisor) {
        final long steps = (Math.abs(value) + divisor / 2) / divisor;
        return value < 0 ? -steps : steps;
    }

    private static long halfEven(final long value, final long divisor) {
        final long quotient = Math.floorDiv(value, divisor);
        final long twiceRemainder = 2 * (value - quotient * divisor);
        if (twiceRemainder > divisor || (twiceRemainder == divisor && (quotient & 1) != 0)) {
            return quotient + 1;
        }
        return quotient;
    }
}
