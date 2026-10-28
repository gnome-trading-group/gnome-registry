package group.gnometrading.sm;

import java.util.List;

/**
 * Open events matching every given filter, for {@link group.gnometrading.SecurityMaster#getEvents}. Empty lists, 0 and
 * {@code null} mean no filter.
 *
 * @param exchangeIds on any of these exchanges
 * @param categories in any of these categories
 * @param tags carrying any of these tags
 * @param expiresBeforeMillis expiring before this epoch millis
 * @param minVolume24h with at least this 24-hour volume; events with no reading yet never match
 * @param order which events come first, and so which a {@code limit} keeps
 * @param limit at most this many
 */
public record EventQuery(
        List<Integer> exchangeIds,
        List<String> categories,
        List<String> tags,
        long expiresBeforeMillis,
        double minVolume24h,
        Order order,
        int limit) {

    public enum Order {
        /** Largest 24-hour volume first; events with no reading last. */
        VOLUME,
        /** Soonest expiry first. */
        EXPIRY
    }
}
