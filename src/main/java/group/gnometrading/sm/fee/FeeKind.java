package group.gnometrading.sm.fee;

/** How a {@link FeeComponent}'s rate applies to a fill of {@code qty} at {@code p} dollars. */
public enum FeeKind {
    /** {@code rate × qty × (p(1−p))^exponent}, for binary contracts priced in [0, 1]. */
    PRICE_CURVE,
    /** {@code rate × qty × p}, a share of the notional. */
    NOTIONAL,
    /** {@code rate × qty}, dollars per contract. */
    PER_UNIT
}
