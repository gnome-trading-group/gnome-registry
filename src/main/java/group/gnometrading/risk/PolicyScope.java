package group.gnometrading.risk;

public enum PolicyScope {
    GLOBAL(0),
    STRATEGY(1),
    LISTING(2);

    private final int value;

    PolicyScope(final int value) {
        this.value = value;
    }

    public int value() {
        return value;
    }

    public static PolicyScope fromInt(final int value) {
        return switch (value) {
            case 0 -> GLOBAL;
            case 1 -> STRATEGY;
            case 2 -> LISTING;
            default -> null;
        };
    }
}
