package group.gnometrading.sm;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.deser.std.StdDeserializer;
import group.gnometrading.schemas.SchemaType;
import java.io.IOException;

public final class SchemaTypeDeserializer extends StdDeserializer<SchemaType> {

    public SchemaTypeDeserializer() {
        super(SchemaType.class);
    }

    @Override
    public SchemaType deserialize(final JsonParser parser, final DeserializationContext ctx) throws IOException {
        final String value = parser.getText();
        try {
            return SchemaType.findById(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    @Override
    public SchemaType getNullValue(final DeserializationContext ctx) {
        return null;
    }
}
