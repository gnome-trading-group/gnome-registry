package group.gnometrading.sm;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.deser.std.StdDeserializer;
import java.io.IOException;
import java.time.Instant;
import java.time.format.DateTimeParseException;

public final class EpochMillisDeserializer extends StdDeserializer<Long> {

    public EpochMillisDeserializer() {
        super(Long.class);
    }

    @Override
    public Long deserialize(final JsonParser parser, final DeserializationContext ctx) throws IOException {
        final String text = parser.getText();
        try {
            return Instant.parse(text).toEpochMilli();
        } catch (DateTimeParseException e) {
            return 0L;
        }
    }

    @Override
    public Long getNullValue(final DeserializationContext ctx) {
        return 0L;
    }
}
