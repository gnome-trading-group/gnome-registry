package group.gnometrading.md;

public enum SourceKind {
    /** A trading venue; one per exchange, collecting in the exchange's region. */
    VENUE,
    /** A data vendor, with no exchange; collects in its own home region. */
    VENDOR
}
