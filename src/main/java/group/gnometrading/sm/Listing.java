package group.gnometrading.sm;

public record Listing(
        int listingId,
        int exchangeId,
        int securityId,
        String exchangeSecurityId,
        String exchangeSecuritySymbol
) {}
