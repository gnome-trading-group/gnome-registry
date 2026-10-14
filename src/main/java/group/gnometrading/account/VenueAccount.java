package group.gnometrading.account;

/**
 * The venue account a session trades on one exchange with. The credentials are not here, only the name of the
 * Secrets Manager secret that holds them. {@code funderAddress} is the Polymarket wallet that holds funds and
 * positions, and null on other venues.
 */
public record VenueAccount(
        int accountId, int exchangeId, String label, String tradingSecretName, String funderAddress) {}
