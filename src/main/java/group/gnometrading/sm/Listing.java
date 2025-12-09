package group.gnometrading.sm;

import group.gnometrading.schemas.SchemaType;

public record Listing(
        int listingId,
        int exchangeId,
        int securityId,
        String exchangeSecurityId,
        String exchangeSecuritySymbol,
        SchemaType schemaType
) {}
