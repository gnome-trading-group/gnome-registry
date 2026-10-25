package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public record Exchange(int exchangeId, String exchangeCode, String exchangeName, String region) {}
