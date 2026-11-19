package group.gnometrading.sm;

/** What a listing's orders must respect at the venue: the prices it trades at, and its size rules. */
public record ListingSpec(
        int listingId, PriceGrid grid, long lotSize, long minNotional, long contractMultiplier, long minSize) {}
