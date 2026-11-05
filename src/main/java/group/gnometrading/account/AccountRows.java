package group.gnometrading.account;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.Map;

/** The registry's venue-account rows as {@link VenueAccount}s. Read at startup only, so it allocates freely. */
final class AccountRows {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Row(
            int accountId, int exchangeId, String label, String tradingSecretName, Map<String, Object> venueRef) {}

    private AccountRows() {}

    static List<VenueAccount> parse(final ByteBuffer response) throws IOException {
        final byte[] body = new byte[response.remaining()];
        response.get(body);
        final Row[] rows = OBJECT_MAPPER.readValue(body, Row[].class);
        final VenueAccount[] accounts = new VenueAccount[rows.length];
        for (int i = 0; i < rows.length; i++) {
            final Row row = rows[i];
            final Object funder = row.venueRef() == null ? null : row.venueRef().get("funderAddress");
            accounts[i] = new VenueAccount(
                    row.accountId(),
                    row.exchangeId(),
                    row.label(),
                    row.tradingSecretName(),
                    funder == null ? null : funder.toString());
        }
        return List.of(accounts);
    }
}
