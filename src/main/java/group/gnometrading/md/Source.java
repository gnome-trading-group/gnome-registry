package group.gnometrading.md;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** Where market data comes from: a trading venue or a data vendor. {@code exchangeId} is 0 for a vendor. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Source(
        int sourceId,
        String code,
        SourceKind kind,
        int exchangeId,
        String homeRegion,
        String adapter,
        String[] families,
        boolean active) {}
