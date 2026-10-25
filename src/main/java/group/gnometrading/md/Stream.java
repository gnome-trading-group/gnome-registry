package group.gnometrading.md;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import group.gnometrading.sm.EpochMillisDeserializer;

/**
 * One thing collected from a source: a listing's book ({@code subjectKind} LISTING) or a vendor subject such as an
 * esports match. {@code listingId} and {@code eventId} are 0 when absent. {@code startsAt} and {@code endsAt} are epoch
 * millis, 0 for a listing's stream, whose lifetime is the listing's. {@code resolvedRegion} is where the stream is
 * collected.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Stream(
        int streamId,
        int sourceId,
        String sourceCode,
        String subjectKind,
        int listingId,
        String nativeSubjectId,
        String family,
        String resolvedRegion,
        int eventId,
        @JsonDeserialize(using = EpochMillisDeserializer.class) long startsAt,
        @JsonDeserialize(using = EpochMillisDeserializer.class) long endsAt,
        boolean active) {}
