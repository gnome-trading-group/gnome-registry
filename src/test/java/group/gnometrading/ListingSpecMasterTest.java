package group.gnometrading;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import group.gnometrading.sm.ListingSpec;
import group.gnometrading.sm.ListingSpecMaster;
import group.gnometrading.strings.ViewString;
import java.nio.ByteBuffer;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ListingSpecMasterTest {

    @Mock
    private RegistryConnection registryConnection;

    @InjectMocks
    private ListingSpecMaster listingSpecMaster;

    private static Stream<Arguments> testGetListingSpecArguments() {
        return Stream.of(
                Arguments.of(1, "[]", null),
                Arguments.of(
                        42,
                        """
                        [{"listing_id": 42, "tick_size": 100, "lot_size": 1000, "min_notional": 50000}]""",
                        new ListingSpec(42, 100L, 1000L, 50000L)),
                Arguments.of(
                        99,
                        """
                        [{"listing_id": 99, "tick_size": 10, "lot_size": 100}]""",
                        new ListingSpec(99, 10L, 100L, 0L)));
    }

    @ParameterizedTest
    @MethodSource("testGetListingSpecArguments")
    void testGetListingSpec(int listingId, String jsonResponse, ListingSpec expected) {
        when(registryConnection.get(new ViewString("/api/listing-specs?listingId=" + listingId)))
                .thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));
        ListingSpec result = listingSpecMaster.getListingSpec(listingId);
        assertEquals(expected, result);
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetListingSpecCaching() {
        String jsonResponse =
                """
                [{"listing_id": 42, "tick_size": 100, "lot_size": 1000, "min_notional": 0}]""";
        when(registryConnection.get(new ViewString("/api/listing-specs?listingId=42")))
                .thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));

        ListingSpec first = listingSpecMaster.getListingSpec(42);
        ListingSpec second = listingSpecMaster.getListingSpec(42);

        assertSame(first, second);
        verify(registryConnection, times(1)).get(any());
    }
}
