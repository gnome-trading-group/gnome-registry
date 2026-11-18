package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * A venue. {@code homeZoneId} is the availability zone ID (e.g. {@code use2-az2}) its order gateways and production
 * market-data shards run in, the zone measured nearest the venue; null when the exchange has none.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Exchange(int exchangeId, String exchangeCode, String exchangeName, String region, String homeZoneId) {

    /** An exchange with no home zone. */
    public Exchange(final int exchangeId, final String exchangeCode, final String exchangeName, final String region) {
        this(exchangeId, exchangeCode, exchangeName, region, null);
    }
}
