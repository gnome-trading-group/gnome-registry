package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum AssetClass {
    CRYPTO(0),
    EQUITY(1),
    COMMODITY(2),
    FX(3),
    INDEX(4),
    PREDICTION(5);

    private final int code;

    AssetClass(final int code) {
        this.code = code;
    }

    @JsonValue
    public int code() {
        return code;
    }

    @JsonCreator
    public static AssetClass fromCode(final int code) {
        return switch (code) {
            case 0 -> CRYPTO;
            case 1 -> EQUITY;
            case 2 -> COMMODITY;
            case 3 -> FX;
            case 4 -> INDEX;
            case 5 -> PREDICTION;
            default -> throw new IllegalArgumentException("Unknown AssetClass code: " + code);
        };
    }
}
