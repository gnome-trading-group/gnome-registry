package group.gnometrading;

import group.gnometrading.networking.http.HTTPProtocol;
import group.gnometrading.networking.http.HTTPResponse;
import group.gnometrading.networking.http.RetryableHTTPClient;
import group.gnometrading.strings.GnomeString;
import java.io.IOException;
import java.nio.ByteBuffer;

public final class RegistryConnection {

    private static final String API_KEY_HEADER = "x-api-key";

    private final String url;
    private final String apiKey;
    private final RetryableHTTPClient httpClient;

    public RegistryConnection(final String url, final String apiKey) {
        this.url = url;
        this.apiKey = apiKey;
        this.httpClient = new RetryableHTTPClient();
    }

    public ByteBuffer get(final GnomeString path) {
        try {
            final HTTPResponse response =
                    httpClient.get(HTTPProtocol.HTTPS, this.url, path, API_KEY_HEADER, this.apiKey);
            if (response.isSuccess()) {
                return response.getBody();
            }
            throw new RuntimeException("Unable to request the registry. Status code: " + response.getStatusCode());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    public void post(final GnomeString path, final byte[] body, final int length) {
        try {
            final HTTPResponse response = httpClient.post(
                    HTTPProtocol.HTTPS,
                    this.url,
                    path,
                    body,
                    length,
                    API_KEY_HEADER,
                    this.apiKey,
                    "Content-Type",
                    "application/json");
            if (response.isSuccess()) {
                return;
            }
            throw new RuntimeException("Unable to post to the registry. Status code: " + response.getStatusCode());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }
}
