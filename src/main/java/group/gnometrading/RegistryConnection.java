package group.gnometrading;

import group.gnometrading.networking.http.HTTPClient;
import group.gnometrading.networking.http.HTTPProtocol;
import group.gnometrading.networking.http.HTTPResponse;
import group.gnometrading.strings.GnomeString;
import java.io.IOException;
import java.nio.ByteBuffer;

public final class RegistryConnection {

    private static final String API_KEY_HEADER = "x-api-key";
    private static final int DEFAULT_MAX_RETRIES = 2;

    private final String url;
    private final String apiKey;
    private final HTTPClient httpClient;
    private final int maxRetries;

    public RegistryConnection(final String url, final String apiKey) {
        this(url, apiKey, DEFAULT_MAX_RETRIES);
    }

    public RegistryConnection(final String url, final String apiKey, final int maxRetries) {
        this.url = url;
        this.apiKey = apiKey;
        this.httpClient = new HTTPClient();
        this.maxRetries = maxRetries;
    }

    public ByteBuffer get(final GnomeString path) {
        RuntimeException last = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                final HTTPResponse response =
                        httpClient.get(HTTPProtocol.HTTPS, this.url, path, API_KEY_HEADER, this.apiKey);
                if (response.isSuccess()) {
                    return response.getBody();
                }
                last = new RuntimeException("Unable to request the registry. Status code: " + response.getStatusCode());
            } catch (IOException e) {
                last = new RuntimeException(e);
            }
        }
        throw last;
    }

    public void post(final GnomeString path, final byte[] body, final int length) {
        RuntimeException last = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
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
                last = new RuntimeException("Unable to post to the registry. Status code: " + response.getStatusCode());
            } catch (IOException e) {
                last = new RuntimeException(e);
            }
        }
        throw last;
    }
}
