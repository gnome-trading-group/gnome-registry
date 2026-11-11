package group.gnometrading.sm;

import java.util.List;

/**
 * Active listings matching every given filter, largest 24-hour volume first, for
 * {@link group.gnometrading.SecurityMaster#getListingVolumes}. Empty lists, 0 and {@code null} mean no filter.
 *
 * @param exchangeIds on any of these exchanges
 * @param securityTypes of a security of any of these types
 * @param minVolume24h with at least this 24-hour volume; listings with no reading yet never match
 * @param limit at most this many
 */
public record ListingQuery(
        List<Integer> exchangeIds, List<SecurityType> securityTypes, double minVolume24h, int limit) {}
