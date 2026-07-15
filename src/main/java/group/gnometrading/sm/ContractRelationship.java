package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public record ContractRelationship(
        int relationshipId,
        int securityIdA,
        int securityIdB,
        String relationshipType,
        float confidence,
        String method) {}
