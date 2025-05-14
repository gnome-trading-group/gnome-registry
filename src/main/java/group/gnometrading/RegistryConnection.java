package group.gnometrading;

import group.gnometrading.networking.http.HTTPClient;
import group.gnometrading.networking.http.HTTPProtocol;
import group.gnometrading.networking.http.HTTPResponse;
import group.gnometrading.strings.GnomeString;

import java.io.IOException;
import java.nio.ByteBuffer;

public class RegistryConnection {

    private static final String API_KEY_HEADER = "x-api-key";

    private final String url;
    private final String apiKey;
    private final HTTPClient httpClient;

    public RegistryConnection(final String url, final String apiKey) {
        this.url = url;
        this.apiKey = apiKey;
        this.httpClient = new HTTPClient();
    }

    public ByteBuffer get(final GnomeString path) {
        try {
            final HTTPResponse response = httpClient.get(HTTPProtocol.HTTPS, this.url, path, API_KEY_HEADER, this.apiKey);

            if (!response.isSuccess()) {
                throw new RuntimeException("Unable to request the security master. Status code: " + response.getStatusCode());
            }
            return response.getBody();
        } catch (IOException e) {
            // TODO: How are we handling runtime errors?
            throw new RuntimeException(e);
        }
    }
}
