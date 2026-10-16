package group.gnometrading.sm.fee;

/** The fills a {@link FeeComponent} charges: every fill, or only buys or only sells. */
public enum FeeSide {
    BOTH,
    BUY,
    SELL;

    boolean applies(final boolean buy) {
        return this == BOTH || (this == BUY) == buy;
    }
}
