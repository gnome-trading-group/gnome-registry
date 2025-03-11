package group.gnometrading;

import group.gnometrading.sm.Exchange;
import group.gnometrading.sm.Listing;
import group.gnometrading.sm.Security;
import group.gnometrading.strings.ViewString;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.nio.ByteBuffer;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SecurityMasterTest {

    @Mock
    private RegistryConnection registryConnection;

    @InjectMocks
    private SecurityMaster securityMaster;

    private static Stream<Arguments> testGetSecurityArguments() {
        return Stream.of(
                Arguments.of(1, "[]", null),
                Arguments.of(123, """
                        [{"security_id": 123, "type": 0, "symbol": "BTC"}]""", new Security(123, "BTC", 0)),
                Arguments.of(123, """
                        [{"security_id": 123}]""", new Security(123, null, -1))
        );
    }

    @ParameterizedTest
    @MethodSource("testGetSecurityArguments")
    void testGetSecurity(int securityId, String jsonResponse, Security expected) {
        when(registryConnection.get(new ViewString("/api/securities?securityId=" + securityId))).thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));
        Security result = securityMaster.getSecurity(securityId);
        assertEquals(expected, result);
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testStoresSecurity() {
        final String securityString = """
                [{"symbol": "BTC", "type": 0, "random": 5}]
                """;

        when(registryConnection.get(new ViewString("/api/securities?securityId=1"))).thenReturn(ByteBuffer.wrap(securityString.getBytes()));

        final Security expected = new Security(1, "BTC", 0);
        Security result = securityMaster.getSecurity(1);
        assertEquals(expected, result);

        result = securityMaster.getSecurity(1);
        assertEquals(expected, result);

        verify(registryConnection, times(1)).get(any());
    }

    private static Stream<Arguments> testGetExchangeArguments() {
        return Stream.of(
                Arguments.of(99, "[]", null),
                Arguments.of(12399, """
                        [{"exchange_id": 12399, "exchange_name": "BTC"}]""", new Exchange(12399, "BTC")),
                Arguments.of(12356, """
                        [{"exchange_id": 12356}]""", new Exchange(12356, null))
        );
    }

    @ParameterizedTest
    @MethodSource("testGetExchangeArguments")
    void testGetExchange(int exchangeId, String jsonResponse, Exchange expected) {
        when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=" + exchangeId))).thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));
        Exchange result = securityMaster.getExchange(exchangeId);
        assertEquals(expected, result);
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testStoresExchange() {
        final String exchangeString = """
                [{"exchange_name": "Binance"}]
                """;

        when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=99"))).thenReturn(ByteBuffer.wrap(exchangeString.getBytes()));

        final Exchange expected = new Exchange(99, "Binance");
        Exchange result = securityMaster.getExchange(99);
        assertEquals(expected, result);

        result = securityMaster.getExchange(99);
        assertEquals(expected, result);

        verify(registryConnection, times(1)).get(any());
    }

    private static Stream<Arguments> testGetListingArguments() {
        return Stream.of(
                Arguments.of(1, "[]", null),
                Arguments.of(12, """
                        [{"listing_id": 12, "exchange_id": 12399, "security_id": 34, "exchange_security_id": "SecId", "exchange_security_symbol": "Binance"}]""", new Listing(12, 12399, 34, "SecId", "Binance"))
        );
    }

    @ParameterizedTest
    @MethodSource("testGetListingArguments")
    void testGetListing(int listingId, String jsonResponse, Listing expected) {
        when(registryConnection.get(new ViewString("/api/listings?listingId=" + listingId))).thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));
        Listing result = securityMaster.getListing(listingId);
        assertEquals(expected, result);
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testStoresListing() {
        final String listingString = """
                [{"listing_id": 1, "exchange_id": 99, "security_id": 101, "exchange_security_id": "SecId", "exchange_security_symbol": "Binance"}]
                """;

        when(registryConnection.get(new ViewString("/api/listings?listingId=1"))).thenReturn(ByteBuffer.wrap(listingString.getBytes()));

        final Listing expected = new Listing(1, 99, 101, "SecId", "Binance");
        Listing result = securityMaster.getListing(1);
        assertEquals(expected, result);

        result = securityMaster.getListing(1);
        assertEquals(expected, result);

        verify(registryConnection, times(1)).get(any());
    }
}