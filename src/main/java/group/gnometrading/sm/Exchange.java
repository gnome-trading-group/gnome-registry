package group.gnometrading.sm;

import group.gnometrading.schemas.SchemaType;

public record Exchange(int exchangeId, String exchangeName, String region, SchemaType schemaType) {}
