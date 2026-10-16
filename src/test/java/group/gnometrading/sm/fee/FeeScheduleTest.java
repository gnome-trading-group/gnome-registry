package group.gnometrading.sm.fee;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class FeeScheduleTest {

    private static final long DOLLAR = 1_000_000_000L;
    private static final long CONTRACT = 1_000_000L;
    private static final long CENT = DOLLAR / 100;

    private static long dollars(final String amount) {
        return new java.math.BigDecimal(amount).movePointRight(9).longValueExact();
    }

    private static long contracts(final String amount) {
        return new java.math.BigDecimal(amount).movePointRight(6).longValueExact();
    }

    private static FeeSchedule curve(final double taker, final double maker, final FeeRounding rounding) {
        return new FeeSchedule(
                "USD",
                new FeeComponent[] {new FeeComponent(FeeKind.PRICE_CURVE, taker, maker, 1, FeeSide.BOTH)},
                rounding);
    }

    private static final FeeSchedule KALSHI = curve(
            0.07,
            0.0175,
            new FeeRounding(FeeRounding.Mode.CEIL, dollars("0.0001"), FeeRounding.Scope.ORDER_ACCUMULATOR));
    private static final FeeSchedule POLYMARKET_US =
            curve(0.0695, -0.0125, new FeeRounding(FeeRounding.Mode.HALF_EVEN, CENT, FeeRounding.Scope.FILL));

    @Test
    void kalshiCarriesRoundingAcrossAnOrdersFills() {
        // A real demo order (2026-10-14): one taker buy at $0.55 matched a 10-lot then a 1-lot.
        final OrderFeeState order = new OrderFeeState();
        final long price = dollars("0.55");

        assertEquals(dollars("0.1733"), KALSHI.fee(true, price, 10 * CONTRACT, false, order));
        assertEquals(dollars("0.0173"), KALSHI.fee(true, price, CONTRACT, false, order));
    }

    @Test
    void kalshiRoundsALoneFillsBalanceChangeUp() {
        // 0.07 × 0.55 × 0.45 = $0.017325; the balance moves by -$0.5674, so the fill costs $0.0174.
        assertEquals(dollars("0.0174"), KALSHI.fee(true, dollars("0.55"), CONTRACT, false, null));
    }

    @Test
    void kalshiMakersPayAQuarterOfTheTakerRate() {
        // 0.0175 × 10 × 0.5 × 0.5 = $0.04375, a sell, so the balance rises by $4.95625, rounded down to $4.9562.
        assertEquals(dollars("0.0438"), KALSHI.fee(false, dollars("0.50"), 10 * CONTRACT, true, null));
    }

    @Test
    void kalshiNeverChargesBelowTheModelFee() {
        // Fractional contracts move the balance off the $0.0001 grid; overpayment is rebated, never undercharged.
        final OrderFeeState order = new OrderFeeState();
        long total = 0;
        for (int i = 0; i < 7; i++) {
            final long fee = KALSHI.fee(true, dollars("0.3333"), contracts("0.37"), false, order);
            assertEquals(true, fee >= 0);
            total += fee;
        }
        final long modelFee = Math.round(0.07 * 7 * 0.37 * 0.3333 * 0.6667 * DOLLAR);
        assertEquals(true, total >= modelFee && total - modelFee < dollars("0.0002"), "total " + total);
    }

    @Test
    void polymarketUsRoundsEachFillToTheNearestCent() {
        // Real fills on our account, 2026-10-08 to 2026-10-14.
        assertEquals(dollars("0.02"), POLYMARKET_US.fee(true, dollars("0.436"), CONTRACT, false, null));
        assertEquals(dollars("0.01"), POLYMARKET_US.fee(true, dollars("0.219"), CONTRACT, false, null));
        assertEquals(0, POLYMARKET_US.fee(true, dollars("0.05"), CONTRACT, false, null));
        assertEquals(dollars("0.19"), POLYMARKET_US.fee(true, dollars("0.85"), contracts("21.36"), false, null));
        assertEquals(-CENT, POLYMARKET_US.fee(true, dollars("0.34"), 3 * CONTRACT, true, null));
        assertEquals(-2 * CENT, POLYMARKET_US.fee(false, dollars("0.90"), contracts("15.47"), true, null));
    }

    @Test
    void halfEvenSendsExactHalvesToTheEvenCent() {
        final FeeSchedule perContract = new FeeSchedule(
                "USD",
                new FeeComponent[] {new FeeComponent(FeeKind.PER_UNIT, 0.005, 0, 1, FeeSide.BOTH)},
                new FeeRounding(FeeRounding.Mode.HALF_EVEN, CENT, FeeRounding.Scope.FILL));

        assertEquals(0, perContract.fee(true, DOLLAR, CONTRACT, false, null));
        assertEquals(2 * CENT, perContract.fee(true, DOLLAR, 3 * CONTRACT, false, null));
    }

    @Test
    void polymarketIntlMatchesOnChainFees() {
        // Two taker buys decoded from Polygon OrderFilled events (crypto_fees_v2, rate 0.07).
        final FeeSchedule crypto =
                curve(0.07, 0, new FeeRounding(FeeRounding.Mode.HALF_UP, dollars("0.00001"), FeeRounding.Scope.FILL));

        assertEquals(dollars("0.882"), crypto.fee(true, dollars("0.37"), contracts("54.054055"), false, null));
        assertEquals(dollars("9.19296"), crypto.fee(true, dollars("0.64"), 570 * CONTRACT, false, null));
        assertEquals(0, crypto.fee(true, dollars("0.37"), contracts("54.054055"), true, null));
    }

    @Test
    void partsSummedBeforeRoundingRoundOnce() {
        final FeeSchedule crypto =
                curve(0.07, 0, new FeeRounding(FeeRounding.Mode.HALF_UP, dollars("0.00001"), FeeRounding.Scope.FILL));
        // Each leg alone is $0.0000042, which rounds to nothing; together they reach a cent's thousandth.
        final long leg = crypto.rawPico(true, dollars("0.5"), contracts("0.00024"), false);

        assertEquals(0, crypto.roundFill(leg));
        assertEquals(dollars("0.00001"), crypto.roundFill(3 * leg));
    }

    @Test
    void notionalFeesAreAShareOfTheTradeUnrounded() {
        final FeeSchedule perps = new FeeSchedule(
                "USD",
                new FeeComponent[] {new FeeComponent(FeeKind.NOTIONAL, 0.00045, 0.00015, 1, FeeSide.BOTH)},
                FeeRounding.NONE);

        assertEquals(54 * DOLLAR, perps.fee(true, 60_000 * DOLLAR, 2 * CONTRACT, false, null));
        assertEquals(18 * DOLLAR, perps.fee(false, 60_000 * DOLLAR, 2 * CONTRACT, true, null));
    }

    @Test
    void aSideComponentChargesOnlyThatSide() {
        final FeeSchedule sellsOnly = new FeeSchedule(
                "USD",
                new FeeComponent[] {
                    new FeeComponent(FeeKind.PER_UNIT, 0.01, 0.01, 1, FeeSide.BOTH),
                    new FeeComponent(FeeKind.NOTIONAL, 0.0000206, 0.0000206, 1, FeeSide.SELL)
                },
                FeeRounding.NONE);

        assertEquals(dollars("1.00"), sellsOnly.fee(true, 100 * DOLLAR, 100 * CONTRACT, false, null));
        assertEquals(dollars("1.206"), sellsOnly.fee(false, 100 * DOLLAR, 100 * CONTRACT, false, null));
    }

    @Test
    void anAccumulatorMustRoundUp() {
        assertThrows(
                IllegalArgumentException.class,
                () -> curve(
                        0.07, 0, new FeeRounding(FeeRounding.Mode.HALF_UP, 100, FeeRounding.Scope.ORDER_ACCUMULATOR)));
    }
}
