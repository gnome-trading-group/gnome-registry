package group.gnometrading.account;

import group.gnometrading.RegistryConnection;
import group.gnometrading.strings.ViewString;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;

/**
 * The venue accounts the registry bound to a session when it was created, one per exchange the session trades.
 * Read once at startup, so it allocates freely.
 */
public final class SessionAccounts {

    private static final String ENDPOINT = "/api/strategy-sessions/accounts?sessionId=%s";

    private final List<VenueAccount> accounts;

    private SessionAccounts(final List<VenueAccount> accounts) {
        this.accounts = accounts;
    }

    public static SessionAccounts fetch(final RegistryConnection registryConnection, final String sessionId) {
        try {
            return new SessionAccounts(
                    AccountRows.parse(registryConnection.get(new ViewString(String.format(ENDPOINT, sessionId)))));
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
