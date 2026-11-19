package group.gnometrading;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import group.gnometrading.sm.ListingSpec;
import group.gnometrading.sm.PriceGrid;
import group.gnometrading.sm.fee.FeeTimelineJson;
import group.gnometrading.strings.ViewString;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/** Listings' specs over time as the registry serves them, and the cache slots a session's readers share. */
final class ListingSpecs {

    static final String ENDPOINT = "/api/listing-specs?";
    // Ids per bulk request: keeps the URL well under API Gateway's limit.
    static final int LISTINGS_PER_REQUEST = 200;
    // Every row a listing has, corrections and the rows they replaced included: the refresher tells new rows apart from
    // known ones by id, so the history must know every id, not only the ones in force.
    private static final String HISTORY = "&history=true";
    private static final long NANOS_PER_MILLI = 1_000_000L;

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Band(long start, Long end, long step) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Row(
            long id,
            int listingId,
            List<Band> priceBands,
            long lotSize,
            long minNotional,
            long contractMultiplier,
            long minSize,
            String effectiveFrom,
            String recordedAt) {}

    /**
     * A listing's specs in effective order, each holding from its start until the next one's; with the registry ids of
     * the rows they came from (sorted) and the latest time any was recorded.
     */
    record History(long[] startNanos, ListingSpec[] specs, long[] rowIds, long recordedThroughNanos) {
        boolean has(final long rowId) {
            return Arrays.binarySearch(this.rowIds, rowId) >= 0;
        }

        ListingSpec at(final long nanos) {
            ListingSpec spec = null;
            for (int i = 0; i < this.startNanos.length && this.startNanos[i] <= nanos; i++) {
                spec = this.specs[i];
            }
            return spec;
        }
    }

    /**
     * One listing's cached history. The thread that reads specs creates slots; a {@link ListingSpecRefresher} on
     * another thread swaps in a newer history whole, so a reader sees one version or the next, never a mix.
     */
    static final class Slot {
        final int listingId;
        volatile History history;
        // The refresher's alone: when it last found the listing's rows all cached, so it asks only for rows since.
        long checkedThroughNanos;

        Slot(final int listingId, final History history) {
            this.listingId = listingId;
            this.history = history;
            this.checkedThroughNanos = history.recordedThroughNanos();
        }
    }

    private ListingSpecs() {}

    static History fetchHistory(final RegistryConnection connection, final int listingId) {
        return parseHistory(
                connection.get(new ViewString(ENDPOINT + "listingId=" + listingId + HISTORY)),
                listingId,
                System.currentTimeMillis() * NANOS_PER_MILLI);
    }

    /**
     * A listing's history from all its rows: for each effective_from the latest recorded row is in force (a correction
     * replaces the row it fixes). A listing with no rows yet counts as current as of {@code fetchedNanos}, so a
     * refresh looks for its first row from about then.
     */
    static History parseHistory(final ByteBuffer response, final int listingId, final long fetchedNanos) {
        final Row[] rows = parse(response);
        final long[] effective = new long[rows.length];
        final long[] recorded = new long[rows.length];
        final Integer[] order = new Integer[rows.length];
        final long[] rowIds = new long[rows.length];
        long recordedThrough = rows.length == 0 ? fetchedNanos : 0;
        for (int i = 0; i < rows.length; i++) {
            effective[i] = rows[i].effectiveFrom() == null ? 0 : FeeTimelineJson.epochNanos(rows[i].effectiveFrom());
            recorded[i] = rows[i].recordedAt() == null ? 0 : FeeTimelineJson.epochNanos(rows[i].recordedAt());
            recordedThrough = Math.max(recordedThrough, recorded[i]);
            rowIds[i] = rows[i].id();
            order[i] = i;
        }
        Arrays.sort(
                order,
                Comparator.<Integer>comparingLong(i -> effective[i])
                        .thenComparingLong(i -> recorded[i])
                        .thenComparingLong(i -> rows[i].id()));
        final List<Long> starts = new ArrayList<>();
        final List<ListingSpec> specs = new ArrayList<>();
        for (final int i : order) {
            final ListingSpec spec = new ListingSpec(
                    listingId,
                    grid(rows[i].priceBands()),
                    rows[i].lotSize(),
                    rows[i].minNotional(),
                    rows[i].contractMultiplier(),
                    rows[i].minSize());
            if (!starts.isEmpty() && starts.get(starts.size() - 1) == effective[i]) {
                specs.set(specs.size() - 1, spec);
            } else {
                starts.add(effective[i]);
                specs.add(spec);
            }
        }
        Arrays.sort(rowIds);
        return new History(
                starts.stream().mapToLong(Long::longValue).toArray(),
                specs.toArray(new ListingSpec[0]),
                rowIds,
                recordedThrough);
    }

    static Row[] parse(final ByteBuffer response) {
        try {
            final byte[] bytes = new byte[response.remaining()];
            response.duplicate().get(bytes);
            return OBJECT_MAPPER.readValue(bytes, Row[].class);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    static PriceGrid grid(final List<Band> bands) {
        if (bands == null || bands.isEmpty()) {
            throw new IllegalStateException("A listing spec came without price bands");
        }
        final long[] starts = new long[bands.size()];
        final long[] ends = new long[bands.size()];
        final long[] steps = new long[bands.size()];
        for (int i = 0; i < bands.size(); i++) {
            final Band band = bands.get(i);
            starts[i] = band.start();
            ends[i] = band.end() == null ? PriceGrid.OPEN : band.end();
            steps[i] = band.step();
        }
        return PriceGrid.of(starts, ends, steps);
    }
}
