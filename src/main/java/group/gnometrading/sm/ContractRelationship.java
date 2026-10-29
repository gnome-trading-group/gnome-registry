package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record ContractRelationship(
        int relationshipId,
        int securityIdA,
        int securityIdB,
        String relationshipType,
        String method,
        List<String> flags) {}
