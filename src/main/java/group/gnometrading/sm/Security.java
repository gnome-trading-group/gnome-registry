package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

@JsonIgnoreProperties(ignoreUnknown = true)
public record Security(
        int securityId,
        String symbol,
        SecurityType type,
        ContractType contractType,
        AssetClass assetClass,
        String baseCurrency,
        String quoteCurrency,
        String settleCurrency,
        boolean inverse,
        boolean isQuanto,
        @JsonDeserialize(using = EpochMillisDeserializer.class) long expiry,
        long strikePrice,
        boolean active,
        int underlyingSecurityId) {}
