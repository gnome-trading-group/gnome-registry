package group.gnometrading;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import group.gnometrading.networking.http.HTTPProtocol;
import group.gnometrading.networking.http.HTTPResponse;
import group.gnometrading.networking.http.RetryableHTTPClient;
import group.gnometrading.strings.ViewString;
import java.io.IOException;
import org.junit.jupiter.api.Test;

class RegistryConnectionTest {

    private final RetryableHTTPClient client = mock(RetryableHTTPClient.class);
    private final RegistryConnection connection = new RegistryConnection("registry.test", "key", client);
    private final byte[] body = "{}".getBytes();

    @Test
    void tryPostReturnsTheStatusCodeWithoutThrowing() throws IOException {
        final HTTPResponse fenced = mock(HTTPResponse.class);
        when(fenced.getStatusCode()).thenReturn(409);
        when(client.post(
                        any(HTTPProtocol.class),
                        anyString(),
                        any(),
                        any(byte[].class),
                        anyInt(),
                        anyString(),
                        anyString(),
                        anyString(),
                        anyString()))
                .thenReturn(fenced);

        assertEquals(409, connection.tryPost(new ViewString("/api/ledger/batch"), body, body.length));
    }

    @Test
    void tryPostReportsNoResponseWhenTheRequestFails() throws IOException {
        when(client.post(
                        any(HTTPProtocol.class),
                        anyString(),
                        any(),
                        any(byte[].class),
                        anyInt(),
                        anyString(),
                        anyString(),
                        anyString(),
                        anyString()))
                .thenThrow(new IOException("connection refused"));

        assertEquals(
                RegistryConnection.NO_RESPONSE,
                connection.tryPost(new ViewString("/api/ledger/batch"), body, body.length));
    }
}
