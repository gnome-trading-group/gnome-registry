package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum SecurityType {
    SPOT(0),
    PERPETUAL(1),
    FUTURE(2),
    OPTION(3),
    EVENT_CONTRACT(4);

    private final int code;

    SecurityType(final int code) {
        this.code = code;
    }

    @JsonValue
    public int code() {
        return code;
    }

    @JsonCreator
    public static SecurityType fromCode(final int code) {
        return switch (code) {
            case 0 -> SPOT;
            case 1 -> PERPETUAL;
            case 2 -> FUTURE;
            case 3 -> OPTION;
            case 4 -> EVENT_CONTRACT;
            default -> throw new IllegalArgumentException("Unknown SecurityType code: " + code);
        };
    }
}
