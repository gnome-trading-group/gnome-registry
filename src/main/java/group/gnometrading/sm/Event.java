package group.gnometrading.sm;

import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

public record Event(
        int eventId,
        String title,
        String description,
        String category,
        boolean resolved,
        @JsonDeserialize(using = EpochMillisDeserializer.class) long resolvedAt,
        @JsonDeserialize(using = EpochMillisDeserializer.class) long expiry) {}
