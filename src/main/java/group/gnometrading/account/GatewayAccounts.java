package group.gnometrading.account;

import group.gnometrading.RegistryConnection;
import group.gnometrading.strings.ViewString;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;

/**
 * The venue accounts an order gateway holds: those assigned to it that are ACTIVE, or DRAINING (still with orders to
 * cancel and positions to unwind). Read once as the gateway starts, so it allocates freely.
 */
public final class GatewayAccounts {

    private static final String ENDPOINT = "/api/venue-accounts/gateway?gatewayKey=%s";

    private GatewayAccounts() {}

    public static List<VenueAccount> fetch(final RegistryConnection registryConnection, final String gatewayKey) {
        try {
            return AccountRows.parse(registryConnection.get(new ViewString(String.format(ENDPOINT, gatewayKey))));
        } catch (IOException e) {
            throw new UncheckedIOException("Unreadable accounts for gateway " + gatewayKey, e);
        }
    }
}
