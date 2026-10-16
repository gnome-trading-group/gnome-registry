package group.gnometrading.sm.fee;

/**
 * How a fill's fee is rounded.
 *
 * @param mode the rounding rule
 * @param incrementUnits the increment rounded to, in price units (1e9 = $1); ignored for {@link Mode#NONE}
 * @param scope whether each fill is rounded on its own or the order carries its rounding across fills
 */
public record FeeRounding(Mode mode, long incrementUnits, Scope scope) {

    public static final FeeRounding NONE = new FeeRounding(Mode.NONE, 0, Scope.FILL);

    public enum Mode {
        NONE,
        CEIL,
        HALF_UP,
        HALF_EVEN
    }

    public enum Scope {
        /** Each fill's fee is rounded on its own. */
        FILL,
        /**
         * Kalshi (docs.kalshi.com/getting_started/fee_rounding): the fee rounds up to $0.000001, the balance change is
         * then rounded down to the increment, and the excess is carried across the order's fills and rebated in whole
         * increments, so an order's total converges to that of one equivalent fill. Only {@link Mode#CEIL}.
         */
        ORDER_ACCUMULATOR
    }
}
