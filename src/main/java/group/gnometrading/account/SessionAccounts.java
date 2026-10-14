package group.gnometrading.account;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import group.gnometrading.RegistryConnection;
import group.gnometrading.strings.ViewString;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.Map;

/**
 * The venue accounts the registry bound to a session when it was created, one per exchange the session trades.
 * Read once at startup, so it allocates freely.
 */
public final class SessionAccounts {

    private static final String ENDPOINT = "/api/strategy-sessions/accounts?sessionId=%s";

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record AccountResponse(
            int accountId, int exchangeId, String label, String tradingSecretName, Map<String, Object> venueRef) {}

    private final List<VenueAccount> accounts;

    private SessionAccounts(final List<VenueAccount> accounts) {
        this.accounts = accounts;
    }

    public static SessionAccounts fetch(final RegistryConnection registryConnection, final String sessionId) {
        final ByteBuffer response = registryConnection.get(new ViewString(String.format(ENDPOINT, sessionId)));
        final byte[] body = new byte[response.remaining()];
        response.get(body);
        try {
            final AccountResponse[] rows = OBJECT_MAPPER.readValue(body, AccountResponse[].class);
            final VenueAccount[] accounts = new VenueAccount[rows.length];
            for (int i = 0; i < rows.length; i++) {
                final AccountResponse row = rows[i];
                final Object funder =
                        row.venueRef() == null ? null : row.venueRef().get("funderAddress");
                accounts[i] = new VenueAccount(
                        row.accountId(),
                        row.exchangeId(),
                        row.label(),
                        row.tradingSecretName(),
                        funder == null ? null : funder.toString());
            }
            return new SessionAccounts(List.of(accounts));
        } catch (IOException e) {
            throw new UncheckedIOException("Unreadable accounts for session " + sessionId, e);
        }
    }

    public List<VenueAccount> all() {
        return this.accounts;
    }

    /**
     * The account the session trades {@code exchangeId} with.
     *
     * @throws IllegalStateException if the registry bound none, as a live session can't trade without one
     */
    public VenueAccount forExchange(final int exchangeId) {
        for (final VenueAccount account : this.accounts) {
            if (account.exchangeId() == exchangeId) {
                return account;
            }
        }
        throw new IllegalStateException("No venue account bound for exchange " + exchangeId);
    }
}
