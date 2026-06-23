package group.gnometrading.sm;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum ContractType {
    NONE(0),
    LINEAR_PERPETUAL(1),
    INVERSE_PERPETUAL(2),
    LINEAR_FUTURE(3),
    INVERSE_FUTURE(4),
    CALL_OPTION(5),
    PUT_OPTION(6),
    BINARY(7),
    MULTI_OUTCOME(8);

    private final int code;

    ContractType(final int code) {
        this.code = code;
    }

    @JsonValue
    public int code() {
        return code;
    }

    @JsonCreator
    public static ContractType fromCode(final int code) {
        return switch (code) {
            case 0 -> NONE;
            case 1 -> LINEAR_PERPETUAL;
            case 2 -> INVERSE_PERPETUAL;
            case 3 -> LINEAR_FUTURE;
            case 4 -> INVERSE_FUTURE;
            case 5 -> CALL_OPTION;
            case 6 -> PUT_OPTION;
            case 7 -> BINARY;
            case 8 -> MULTI_OUTCOME;
            default -> throw new IllegalArgumentException("Unknown ContractType code: " + code);
        };
    }
}
