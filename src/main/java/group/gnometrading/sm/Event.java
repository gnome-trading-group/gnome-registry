package group.gnometrading.sm;

public record Event(
        int eventId,
        String title,
        String description,
        String category,
        boolean resolved,
        long resolvedAt,
        long expiry) {}
