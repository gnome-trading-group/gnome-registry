package group.gnometrading.sm;

public record Listing(
        int listingId,
        Exchange exchange,
        Security security,
        String exchangeSecurityId,
        String exchangeSecuritySymbol
) {}
