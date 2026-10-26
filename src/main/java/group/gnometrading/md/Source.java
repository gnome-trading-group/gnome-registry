package group.gnometrading.md;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Where market data comes from: a trading venue or a data vendor. {@code exchangeId} is 0 for a vendor.
 *
 * <p>Its connections' capacity: {@code maxPerConnection} subjects each; {@code connectionsPerScope} connections per
 * {@code connectionScope} (an IP, an API key or an account) and {@code clientMessagesPerMinute} commands, both 0 when
 * the source has no known limit.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Source(
        int sourceId,
        String code,
        SourceKind kind,
        int exchangeId,
        String homeRegion,
        String adapter,
        String[] families,
        boolean active,
        int maxPerConnection,
        String connectionScope,
        int connectionsPerScope,
        int clientMessagesPerMinute) {}
