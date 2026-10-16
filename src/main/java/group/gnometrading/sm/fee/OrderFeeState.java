package group.gnometrading.sm.fee;

/** What one order carries from fill to fill for {@link FeeRounding.Scope#ORDER_ACCUMULATOR} rounding. */
public final class OrderFeeState {

    long accumulatedUnits;

    public void reset() {
        this.accumulatedUnits = 0;
    }

    public void copyFrom(final OrderFeeState src) {
        this.accumulatedUnits = src.accumulatedUnits;
    }
}
