package group.gnometrading.sm.fee;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/** The shared cases gnomepy's calculator must also reproduce (gnomepy/tests/fixtures/fee_vectors.json). */
class FeeVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    static Stream<Arguments> cases() throws IOException {
        try (InputStream in = FeeVectorsTest.class.getResourceAsStream("/fee-vectors.json")) {
            final List<Arguments> cases = new ArrayList<>();
            for (final JsonNode c : MAPPER.readTree(in).get("cases")) {
                cases.add(Arguments.of(c.get("name").asText(), c));
            }
            return cases.stream();
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("cases")
    void reproducesTheCase(final String name, final JsonNode c) throws IOException {
        final String response = "[{\"listingId\":1,\"timeline\":[{\"effectiveFrom\":\"1970-01-01T00:00:00Z\","
                + "\"effectiveTo\":null,\"definition\":" + c.get("definition") + "}]}]";
        final FeeSchedule schedule = FeeTimelineJson.parse(response.getBytes(StandardCharsets.UTF_8), 1)
                .at(0);
        final OrderFeeState order = new OrderFeeState();
        final boolean shared = c.get("sharedOrderState").asBoolean();
        for (final JsonNode fill : c.get("fills")) {
            final long fee = schedule.fee(
                    fill.get("buy").asBoolean(),
                    fill.get("price").asLong(),
                    fill.get("qty").asLong(),
                    fill.get("maker").asBoolean(),
                    shared ? order : null);
            assertEquals(fill.get("fee").asLong(), fee, name + ": " + fill);
        }
    }
}
