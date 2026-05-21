package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import group.gnometrading.schemas.SchemaType;

@JsonIgnoreProperties(ignoreUnknown = true)
public record Exchange(
        int exchangeId,
        String exchangeName,
        String region,
        @JsonDeserialize(using = SchemaTypeDeserializer.class) SchemaType schemaType) {}
