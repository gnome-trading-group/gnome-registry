package group.gnometrading;

import group.gnometrading.networking.http.HTTPClient;
import group.gnometrading.networking.http.HTTPProtocol;
import group.gnometrading.networking.http.HTTPResponse;
import group.gnometrading.resources.Properties;
import group.gnometrading.strings.GnomeString;

import java.io.IOException;
import java.nio.ByteBuffer;

public class RegistryConnection {

    private static final String REGISTRY_API_PROP = "registry.api.url";
    private static final String REGISTRY_API_KEY_PROP = "registry.api.key";
    private static final String API_KEY_HEADER = "x-api-key";

    private final String host;
    private final String key;
    private final HTTPClient httpClient;

    public RegistryConnection(final Properties properties) {
        this.host = properties.getStringProperty(REGISTRY_API_PROP);
        this.key = properties.getStringProperty(REGISTRY_API_KEY_PROP);
        this.httpClient = new HTTPClient();
    }

    public ByteBuffer get(final GnomeString path) {
        try {
            final HTTPResponse response = httpClient.get(HTTPProtocol.HTTPS, this.host, path, API_KEY_HEADER, this.key);

            if (!response.isSuccess()) {
                throw new RuntimeException("Unable to request the security master");
            }
            return response.getBody();
        } catch (IOException e) {
            // TODO: How are we handling runtime errors?
            throw new RuntimeException(e);
        }
    }
}
