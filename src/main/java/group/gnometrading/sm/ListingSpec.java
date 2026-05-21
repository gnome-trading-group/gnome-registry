package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public record ListingSpec(int listingId, long tickSize, long lotSize, long minNotional, long contractMultiplier) {}
