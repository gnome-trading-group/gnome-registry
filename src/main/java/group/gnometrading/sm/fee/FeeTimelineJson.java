package group.gnometrading.sm.fee;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import group.gnometrading.schemas.Statics;
import java.io.IOException;
import java.time.Instant;
import java.util.List;

/** Reads the registry's resolved fee timelines ({@code GET /fees?listingIds=}) into {@link FeeTimeline}s. */
public final class FeeTimelineJson {

    private static final ObjectMapper MAPPER =
            new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    private static final long NANOS_PER_SECOND = 1_000_000_000L;

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ListingTimeline(int listingId, List<Entry> timeline) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Entry(String effectiveFrom, String effectiveTo, Definition definition) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Definition(String currency, List<Component> components, Rounding rounding) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Component(String kind, double taker, double maker, Double exponent, String side) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Rounding(String mode, Double increment, String scope) {}

    private FeeTimelineJson() {}

    /** The timeline of {@code listingId} in a response, or an empty one if the response doesn't name it. */
    public static FeeTimeline parse(final byte[] json, final int listingId) throws IOException {
        for (final ListingTimeline listing : MAPPER.readValue(json, ListingTimeline[].class)) {
            if (listing.listingId() == listingId) {
                return toTimeline(listing.timeline());
            }
        }
        return FeeTimeline.EMPTY;
    }

    private static FeeTimeline toTimeline(final List<Entry> entries) {
        final long[] starts = new long[entries.size()];
        final long[] ends = new long[entries.size()];
        final FeeSchedule[] schedules = new FeeSchedule[entries.size()];
        for (int i = 0; i < entries.size(); i++) {
            final Entry entry = entries.get(i);
            starts[i] = epochNanos(entry.effectiveFrom());
            ends[i] = entry.effectiveTo() == null ? FeeTimeline.OPEN_ENDED : epochNanos(entry.effectiveTo());
            schedules[i] = toSchedule(entry.definition());
        }
        return new FeeTimeline(starts, ends, schedules);
    }

    private static FeeSchedule toSchedule(final Definition definition) {
        final FeeComponent[] components =
                new FeeComponent[definition.components().size()];
        for (int i = 0; i < components.length; i++) {
            final Component c = definition.components().get(i);
            components[i] = new FeeComponent(
                    FeeKind.valueOf(c.kind()),
                    c.taker(),
                    c.maker(),
                    c.exponent() == null ? 1.0 : c.exponent(),
                    c.side() == null ? FeeSide.BOTH : FeeSide.valueOf(c.side()));
        }
        final Rounding r = definition.rounding();
        final FeeRounding.Mode mode = FeeRounding.Mode.valueOf(r.mode());
        final FeeRounding rounding = mode == FeeRounding.Mode.NONE
                ? FeeRounding.NONE
                : new FeeRounding(
                        mode,
                        Math.round(r.increment() * Statics.PRICE_SCALING_FACTOR),
                        FeeRounding.Scope.valueOf(r.scope()));
        return new FeeSchedule(definition.currency(), components, rounding);
    }

    /** ISO-8601 to epoch nanoseconds. */
    public static long epochNanos(final String iso) {
        final Instant instant = Instant.parse(iso);
        return instant.getEpochSecond() * NANOS_PER_SECOND + instant.getNano();
    }
}
