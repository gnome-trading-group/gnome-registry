package group.gnometrading.md;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import group.gnometrading.sm.EpochMillisDeserializer;

/**
 * One thing collected from a source: a listing's book ({@code subjectKind} LISTING) or a vendor subject such as an
 * esports match. {@code eventId} is a vendor subject's event, or a listing's through its contract. {@code listingId}
 * and {@code eventId} are 0 when absent. {@code startsAt} and {@code endsAt} are epoch
 * millis, 0 for a listing's stream, whose lifetime is the listing's. {@code resolvedRegion} is where the stream is
 * collected; {@code homeZoneId} the availability zone ID its exchange's production shards run in, null for a vendor
 * stream, an exchange with no home zone, or a stream collected outside its exchange's region.
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
        boolean active,
        String homeZoneId) {

    /** A stream with no home zone. */
    public Stream(
            final int streamId,
            final int sourceId,
            final String sourceCode,
            final String subjectKind,
            final int listingId,
            final String nativeSubjectId,
            final String family,
            final String resolvedRegion,
            final int eventId,
            final long startsAt,
            final long endsAt,
            final boolean active) {
        this(
                streamId,
                sourceId,
                sourceCode,
                subjectKind,
                listingId,
                nativeSubjectId,
                family,
                resolvedRegion,
                eventId,
                startsAt,
                endsAt,
                active,
                null);
    }
}
