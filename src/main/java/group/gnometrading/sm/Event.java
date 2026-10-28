package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

/**
 * An exchange's event. {@code resolvedAt} and {@code expiry} are epoch millis, 0 when absent. {@code volume24h} is about
 * USD traded over the last 24 hours as the classifier last saw it, 0 before its first reading.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Event(
        int eventId,
        int exchangeId,
        String title,
        String description,
        String category,
        boolean resolved,
        @JsonDeserialize(using = EpochMillisDeserializer.class) long resolvedAt,
        @JsonDeserialize(using = EpochMillisDeserializer.class) long expiry,
        @JsonProperty("volume_24h") double volume24h) {}
