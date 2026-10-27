package group.gnometrading.md;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * A dedicated market-data account a source's shards collect with, its key in Secrets Manager under {@code secretName}.
 * {@code connectionBudget} is the connections it may hold, 0 for the source's own {@code connectionsPerScope}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record SourceAccount(
        int accountId,
        int sourceId,
        String sourceCode,
        String label,
        String secretName,
        int connectionBudget,
        String status) {

    public boolean active() {
        return "ACTIVE".equals(status);
    }
}
