package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A listing and its 24-hour volume: about USD traded over the last 24 hours as the exchange sync last read it from the
 * venue, 0 before its first reading.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ListingVolume(int listingId, int exchangeId, @JsonProperty("volume_24h") double volume24h) {}
