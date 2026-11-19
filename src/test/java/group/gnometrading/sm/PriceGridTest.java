package group.gnometrading.sm;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/** The shared cases gnomepy's grid must also reproduce (gnomepy/tests/fixtures/price_grid_vectors.json). */
class PriceGridTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final JsonNode VECTORS = load();

    private static JsonNode load() {
        try (InputStream in = PriceGridTest.class.getResourceAsStream("/price-grid-vectors.json")) {
            return MAPPER.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static PriceGrid grid(final JsonNode bands) {
        final long[] starts = new long[bands.size()];
        final long[] ends = new long[bands.size()];
        final long[] steps = new long[bands.size()];
        for (int i = 0; i < bands.size(); i++) {
            starts[i] = bands.get(i).get(0).asLong();
            ends[i] = bands.get(i).get(1).isNull()
                    ? PriceGrid.OPEN
                    : bands.get(i).get(1).asLong();
            steps[i] = bands.get(i).get(2).asLong();
        }
        return PriceGrid.of(starts, ends, steps);
    }

    private static PriceGrid named(final String name) {
        return grid(VECTORS.get("grids").get(name));
    }

    static Stream<Arguments> cases() {
        final List<Arguments> cases = new ArrayList<>();
        for (final JsonNode c : VECTORS.get("cases")) {
            cases.add(Arguments.of(c.get("grid").asText() + " " + c.get("op").asText() + " " + c.get("args"), c));
        }
        return cases.stream();
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("cases")
    void reproducesTheCase(final String name, final JsonNode c) {
        final PriceGrid grid = named(c.get("grid").asText());
        final JsonNode args = c.get("args");
        final JsonNode expected = c.get("expected");
        switch (c.get("op").asText()) {
            case "valid" -> assertEquals(
                    expected.asBoolean(), grid.valid(args.get(0).asLong()), name);
            case "floor" -> assertEquals(
                    expected.asLong(), grid.floor(args.get(0).asLong()), name);
            case "ceil" -> assertEquals(expected.asLong(), grid.ceil(args.get(0).asLong()), name);
            case "up" -> assertEquals(
                    expected.asLong(), grid.up(args.get(0).asLong(), args.get(1).asInt()), name);
            case "down" -> assertEquals(
                    expected.asLong(),
                    grid.down(args.get(0).asLong(), args.get(1).asInt()),
                    name);
            case "ticksBetween" -> assertEquals(
                    expected.asLong(),
                    grid.ticksBetween(args.get(0).asLong(), args.get(1).asLong()),
                    name);
            case "min" -> assertEquals(expected.asLong(), grid.min(), name);
            case "max" -> assertEquals(expected.asLong(), grid.max(), name);
            case "finestStep" -> assertEquals(expected.asLong(), grid.finestStep(), name);
            case "bands" -> assertEquals(expected.asInt(), grid.bands(), name);
            case "complement" -> assertEquals(named(expected.asText()), grid.complement(), name);
            default -> throw new IllegalArgumentException("Unknown op in " + name);
        }
    }

    static Stream<Arguments> invalid() {
        final List<Arguments> cases = new ArrayList<>();
        for (final JsonNode c : VECTORS.get("invalid")) {
            cases.add(Arguments.of(c.get("name").asText(), c.get("bands")));
        }
        return cases.stream();
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("invalid")
    void refusesTheGrid(final String name, final JsonNode bands) {
        assertThrows(IllegalArgumentException.class, () -> grid(bands), name);
    }

    @Test
    void stepsNearTheTopOfAnOpenGridStopAtItsEnd() {
        final PriceGrid grid = named("us_equity");
        assertEquals(PriceGrid.OPEN, grid.ceil(PriceGrid.OPEN - 1));
        assertEquals(PriceGrid.OPEN, grid.up(grid.max(), 1));
    }

    @Test
    void anOpenGridHasNoComplement() {
        assertThrows(IllegalStateException.class, () -> named("us_equity").complement());
    }

    @Test
    void aSingleBandIsOneStepToTheEnd() {
        final PriceGrid grid = PriceGrid.single(10_000_000L, 1_000_000_000L);
        assertEquals(named("linear_cent"), grid);
        assertTrue(grid.valid(10_000_000L));
    }

    @Test
    void anOpenGridsHighestPriceIsOnItsLastStep() {
        final PriceGrid grid = named("hyperliquid_perp_sz5");
        assertEquals(0, grid.max() % 1_000_000_000L);
        assertTrue(grid.valid(grid.max()));
    }
}
