package group.gnometrading.sm.fee;

/**
 * One part of a fill's fee, charged at the taker or maker rate by the fill's liquidity. A negative rate is a rebate.
 *
 * @param kind how the rate applies to the fill
 * @param taker the rate a taker pays
 * @param maker the rate a maker pays
 * @param exponent the {@link FeeKind#PRICE_CURVE} exponent; 1 for the other kinds
 * @param side the side the component charges
 */
public record FeeComponent(FeeKind kind, double taker, double maker, double exponent, FeeSide side) {}
