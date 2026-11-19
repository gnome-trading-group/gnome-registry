package group.gnometrading;

import group.gnometrading.strings.ViewString;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;

/**
 * Keeps the specs a {@link SecurityMaster} has cached up to date while it runs: a venue can change a listing's tick
 * mid-session. Each {@link #refresh()} asks the registry for those listings' rows recorded since a little before it
 * last found them all cached, so the answer stays small however long a listing goes unchanged, and swaps in the whole
 * history of each listing that has a row it hasn't seen (a correction can replace an older row). Runs on its own thread with its own registry connection, never the one reading specs; readers
 * never block or allocate for it.
 */
public final class ListingSpecRefresher {

    private static final long NANOS_PER_SECOND = 1_000_000_000L;
    private static final long NANOS_PER_MILLI = 1_000_000L;
    // A row's recorded_at is when its transaction began, so one can commit after a later-stamped row was read: look
    // back this far and tell rows apart by id, not by time.
    private static final long LOOK_BACK_NANOS = 10 * 60 * NANOS_PER_SECOND;

    private final RegistryConnection connection;
    private final Queue<ListingSpecs.Slot> created;
    private final List<ListingSpecs.Slot> slots = new ArrayList<>();

    ListingSpecRefresher(final RegistryConnection connection, final Queue<ListingSpecs.Slot> created) {
        this.connection = connection;
        this.created = created;
    }

    /**
     * What a refresh did: how many listings' specs changed, and how many it couldn't check or reload (each keeps the
     * history it had, and is tried again next time), with the last such error.
     */
    public record Result(int changed, int failed, RuntimeException lastError) {}

    /** Refreshes every cached listing whose specs changed. */
    public Result refresh() {
        ListingSpecs.Slot slot;
        while ((slot = this.created.poll()) != null) {
            this.slots.add(slot);
        }
        int changed = 0;
        int failed = 0;
        RuntimeException lastError = null;
        for (int from = 0; from < this.slots.size(); from += ListingSpecs.LISTINGS_PER_REQUEST) {
            final List<ListingSpecs.Slot> batch =
                    this.slots.subList(from, Math.min(this.slots.size(), from + ListingSpecs.LISTINGS_PER_REQUEST));
            final long asked = System.currentTimeMillis() * NANOS_PER_MILLI;
            final List<ListingSpecs.Slot> stale;
            try {
                stale = staleIn(batch);
            } catch (RuntimeException e) {
                failed += batch.size();
                lastError = e;
                continue;
            }
            for (final ListingSpecs.Slot listing : batch) {
                if (!stale.contains(listing)) {
                    listing.checkedThroughNanos = asked;
                }
            }
            for (final ListingSpecs.Slot listing : stale) {
                try {
                    listing.history = ListingSpecs.fetchHistory(this.connection, listing.listingId);
                    listing.checkedThroughNanos = asked;
                    changed++;
                } catch (RuntimeException e) {
                    failed++;
                    lastError = e;
                }
            }
        }
        return new Result(changed, failed, lastError);
    }

    private List<ListingSpecs.Slot> staleIn(final List<ListingSpecs.Slot> batch) {
        final Map<Integer, ListingSpecs.Slot> byListing = new HashMap<>();
        long since = Long.MAX_VALUE;
        final StringBuilder path = new StringBuilder(ListingSpecs.ENDPOINT).append("listingIds=");
        for (int i = 0; i < batch.size(); i++) {
            final ListingSpecs.Slot slot = batch.get(i);
            byListing.put(slot.listingId, slot);
            since = Math.min(since, slot.checkedThroughNanos - LOOK_BACK_NANOS);
            path.append(i == 0 ? "" : ",").append(slot.listingId);
        }
        path.append("&history=true&recordedAfter=")
                .append(Instant.ofEpochSecond(since / NANOS_PER_SECOND, since % NANOS_PER_SECOND));

        final List<ListingSpecs.Slot> stale = new ArrayList<>();
        for (final ListingSpecs.Row row : ListingSpecs.parse(this.connection.get(new ViewString(path.toString())))) {
            final ListingSpecs.Slot slot = byListing.get(row.listingId());
            if (slot != null && newer(row, slot)) {
                stale.add(slot);
                byListing.remove(row.listingId());
            }
        }
        return stale;
    }

    private static boolean newer(final ListingSpecs.Row row, final ListingSpecs.Slot slot) {
        return !slot.history.has(row.id());
    }
}
