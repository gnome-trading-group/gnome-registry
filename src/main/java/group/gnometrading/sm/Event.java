package group.gnometrading.sm;

public record Event(
        int eventId,
        String title,
        String description,
        String category,
        String resolutionSource,
        boolean resolved,
        long resolvedAt,
        long expiry) {}
