package group.gnometrading;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import group.gnometrading.sm.AssetClass;
import group.gnometrading.sm.ContractRelationship;
import group.gnometrading.sm.ContractType;
import group.gnometrading.sm.Exchange;
import group.gnometrading.sm.Listing;
import group.gnometrading.sm.ListingSpec;
import group.gnometrading.sm.Security;
import group.gnometrading.sm.SecurityType;
import group.gnometrading.sm.SimulationParameters;
import group.gnometrading.sm.fee.FeeTimeline;
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
class SecurityMasterTest {

    @Mock
    private RegistryConnection registryConnection;

    @InjectMocks
    private SecurityMaster securityMaster;

    private static Security spot(final int securityId, final String symbol) {
        return new Security(
                securityId, symbol, SecurityType.SPOT, null, null, null, null, null, false, false, 0L, 0L, false, 0);
    }

    private static Security empty(final int securityId) {
        return new Security(securityId, null, null, null, null, null, null, null, false, false, 0L, 0L, false, 0);
    }

    private static Stream<Arguments> testGetSecurityArguments() {
        return Stream.of(
                Arguments.of(1, "[]", null),
                Arguments.of(
                        123,
                        """
                        [{"security_id": 123, "type": 0, "symbol": "BTC"}]""",
                        spot(123, "BTC")),
                Arguments.of(123, """
                        [{"security_id": 123}]""", empty(123)));
    }

    @ParameterizedTest
    @MethodSource("testGetSecurityArguments")
    void testGetSecurity(int securityId, String jsonResponse, Security expected) {
        when(registryConnection.get(new ViewString("/api/securities?securityId=" + securityId)))
                .thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));
        Security result = securityMaster.getSecurity(securityId);
        assertEquals(expected, result);
        verify(registryConnection, times(1)).get(any());
    }

    private static Stream<Arguments> testGetExchangeArguments() {
        return Stream.of(
                Arguments.of(99, "[]", null),
                Arguments.of(
                        12399,
                        """
                        [{"exchange_id": 12399, "exchange_code": "BTC_VENUE", "exchange_name": "BTC", "region": "us-east-2"}]""",
                        new Exchange(12399, "BTC_VENUE", "BTC", "us-east-2")),
                Arguments.of(
                        12356,
                        """
                        [{"exchange_id": 12356, "region": "us-east-1"}]""",
                        new Exchange(12356, null, null, "us-east-1")));
    }

    @ParameterizedTest
    @MethodSource("testGetExchangeArguments")
    void testGetExchange(int exchangeId, String jsonResponse, Exchange expected) {
        when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=" + exchangeId)))
                .thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));
        Exchange result = securityMaster.getExchange(exchangeId);
        assertEquals(expected, result);
        verify(registryConnection, times(1)).get(any());
    }

    private static Stream<Arguments> testGetListingArguments() {
        return Stream.of(
                Arguments.of(1, 1, 1, "[]", null, null, null),
                Arguments.of(
                        12,
                        12399,
                        34,
                        """
                        [{"listing_id": 12, "exchange_id": 12399, "security_id": 34, "exchange_security_id": "SecId", "exchange_security_symbol": "Binance"}]
                        """,
                        """
                        [{"exchange_id": 12399, "exchange_code": "BTC_VENUE", "exchange_name": "BTC", "region": "us-east-2"}]
                        """,
                        """
                        [{"security_id": 34, "type": 0, "symbol": "BTC"}]
                        """,
                        new Listing(
                                12,
                                new Exchange(12399, "BTC_VENUE", "BTC", "us-east-2"),
                                spot(34, "BTC"),
                                "SecId",
                                "Binance")));
    }

    @ParameterizedTest
    @MethodSource("testGetListingArguments")
    void testGetListing(
            int listingId,
            int exchangeId,
            int securityId,
            String listingResponse,
            String exchangeResponse,
            String securityResponse,
            Listing expected) {
        int calls = 1;
        when(registryConnection.get(new ViewString("/api/listings?listingId=" + listingId)))
                .thenReturn(ByteBuffer.wrap(listingResponse.getBytes()));
        if (exchangeResponse != null) {
            when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=" + exchangeId)))
                    .thenReturn(ByteBuffer.wrap(exchangeResponse.getBytes()));
            calls++;
        }
        if (securityResponse != null) {
            when(registryConnection.get(new ViewString("/api/securities?securityId=" + securityId)))
                    .thenReturn(ByteBuffer.wrap(securityResponse.getBytes()));
            calls++;
        }

        Listing result = securityMaster.getListing(listingId);
        assertEquals(expected, result);
        verify(registryConnection, times(calls)).get(any());
    }

    private static Stream<Arguments> testGetListingByExchangeAndSecurityArguments() {
        return Stream.of(
                Arguments.of(1, 1, "[]", null, null, null),
                Arguments.of(
                        12399,
                        34,
                        """
                        [{"listing_id": 12, "exchange_id": 12399, "security_id": 34, "exchange_security_id": "SecId", "exchange_security_symbol": "Binance"}]
                        """,
                        """
                        [{"exchange_id": 12399, "exchange_code": "BTC_VENUE", "exchange_name": "BTC", "region": "us-east-2"}]
                        """,
                        """
                        [{"security_id": 34, "type": 0, "symbol": "BTC"}]
                        """,
                        new Listing(
                                12,
                                new Exchange(12399, "BTC_VENUE", "BTC", "us-east-2"),
                                spot(34, "BTC"),
                                "SecId",
                                "Binance")));
    }

    @ParameterizedTest
    @MethodSource("testGetListingByExchangeAndSecurityArguments")
    void testGetListingByExchangeAndSecurity(
            int exchangeId,
            int securityId,
            String listingResponse,
            String exchangeResponse,
            String securityResponse,
            Listing expected) {
        int calls = 1;
        when(registryConnection.get(
                        new ViewString("/api/listings?exchangeId=" + exchangeId + "&securityId=" + securityId)))
                .thenReturn(ByteBuffer.wrap(listingResponse.getBytes()));
        if (exchangeResponse != null) {
            when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=" + exchangeId)))
                    .thenReturn(ByteBuffer.wrap(exchangeResponse.getBytes()));
            calls++;
        }
        if (securityResponse != null) {
            when(registryConnection.get(new ViewString("/api/securities?securityId=" + securityId)))
                    .thenReturn(ByteBuffer.wrap(securityResponse.getBytes()));
            calls++;
        }

        Listing result = securityMaster.getListing(exchangeId, securityId);
        assertEquals(expected, result);
        verify(registryConnection, times(calls)).get(any());
    }

    @Test
    void testGetSecurityCaching() {
        String jsonResponse = """
                [{"security_id": 123, "type": 0, "symbol": "BTC"}]""";
        when(registryConnection.get(new ViewString("/api/securities?securityId=123")))
                .thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));

        Security first = securityMaster.getSecurity(123);
        Security second = securityMaster.getSecurity(123);

        assertSame(first, second);
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetExchangeCaching() {
        String jsonResponse =
                """
                [{"exchange_id": 456, "exchange_code": "NYSE_VENUE", "exchange_name": "NYSE", "region": "us-east-1"}]""";
        when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=456")))
                .thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));

        Exchange first = securityMaster.getExchange(456);
        Exchange second = securityMaster.getExchange(456);

        assertSame(first, second);
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testListingFetchedByIdIsFoundByExchangeAndSecurityWithoutAnotherRequest() {
        stubListing(789, 456, 123);

        Listing byId = securityMaster.getListing(789);
        Listing byExchangeAndSecurity = securityMaster.getListing(456, 123);

        assertSame(byId, byExchangeAndSecurity);
        verify(registryConnection, times(3)).get(any()); // listing + exchange + security, once each
    }

    @Test
    void testRepeatedLookupByExchangeAndSecurityRequestsOnce() {
        stubListingByExchangeAndSecurity(789, 456, 123);

        Listing first = securityMaster.getListing(456, 123);
        Listing second = securityMaster.getListing(456, 123);

        assertSame(first, second);
        verify(registryConnection, times(3)).get(any());
    }

    @Test
    void testSameSecurityOnTwoExchangesResolvesToEachListing() {
        stubListing(1, 10, 123);
        stubListing(2, 20, 123);
        securityMaster.getListing(1);
        securityMaster.getListing(2);

        assertEquals(1, securityMaster.getListing(10, 123).listingId());
        assertEquals(2, securityMaster.getListing(20, 123).listingId());
    }

    private static final String LISTING_STREAM_JSON =
            """
            [{"stream_id": 31, "source_id": 2, "source_code": "KALSHI", "source_kind": "VENUE",
              "subject_kind": "LISTING", "listing_id": 789, "native_subject_id": "MKT:yes", "family": "book",
              "region": null, "resolved_region": "us-east-1", "event_id": null, "starts_at": null, "ends_at": null,
              "active": true, "date_created": "2026-10-25T17:00:00.000Z"}]""";

    @Test
    void testStreamForListingReadsTheListingsBookStream() {
        when(registryConnection.get(new ViewString("/api/streams?listingId=789")))
                .thenReturn(ByteBuffer.wrap(LISTING_STREAM_JSON.getBytes()));

        final group.gnometrading.md.Stream stream = securityMaster.streamForListing(789);

        assertEquals(
                new group.gnometrading.md.Stream(
                        31, 2, "KALSHI", "LISTING", 789, "MKT:yes", "book", "us-east-1", 0, 0L, 0L, true),
                stream);
    }

    @Test
    void testStreamFoundByListingIsFoundByIdWithoutAnotherRequest() {
        when(registryConnection.get(new ViewString("/api/streams?listingId=789")))
                .thenReturn(ByteBuffer.wrap(LISTING_STREAM_JSON.getBytes()));

        securityMaster.streamForListing(789);

        assertEquals(789, securityMaster.getStream(31).listingId());
        assertSame(securityMaster.getStream(31), securityMaster.streamForListing(789));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testListingForStreamResolvesThroughTheStream() {
        when(registryConnection.get(new ViewString("/api/streams?streamId=31")))
                .thenReturn(ByteBuffer.wrap(LISTING_STREAM_JSON.getBytes()));
        stubListing(789, 456, 123);

        assertEquals(789, securityMaster.listingForStream(31).listingId());
    }

    @Test
    void testVendorStreamHasNoListingAndKeepsItsWindow() {
        when(registryConnection.get(new ViewString("/api/streams?streamId=40")))
                .thenReturn(ByteBuffer.wrap(
                        """
                        [{"stream_id": 40, "source_id": 9, "source_code": "PANDASCORE", "subject_kind": "MATCH",
                          "listing_id": null, "native_subject_id": "12345", "family": "esports",
                          "resolved_region": "eu-west-1", "event_id": 77, "starts_at": "2026-10-25T18:00:00.000Z",
                          "ends_at": null, "active": true}]"""
                                .getBytes()));

        final group.gnometrading.md.Stream stream = securityMaster.getStream(40);

        assertEquals(0, stream.listingId());
        assertEquals(77, stream.eventId());
        assertEquals(1_792_951_200_000L, stream.startsAt());
        assertEquals(0L, stream.endsAt());
        assertNull(securityMaster.listingForStream(40));
    }

    @Test
    void testMissingStreamIsCachedAsMissing() {
        when(registryConnection.get(new ViewString("/api/streams?streamId=5")))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));

        assertNull(securityMaster.getStream(5));
        assertNull(securityMaster.getStream(5));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testSourceFetchedByCodeIsFoundByIdWithoutAnotherRequest() {
        when(registryConnection.get(new ViewString("/api/sources?code=PANDASCORE")))
                .thenReturn(ByteBuffer.wrap(
                        """
                        [{"source_id": 9, "code": "PANDASCORE", "kind": "VENDOR", "exchange_id": null,
                          "home_region": "eu-west-1", "adapter": "PANDASCORE", "families": ["esports"], "active": true,
                          "max_per_connection": 40, "connection_scope": "KEY", "connections_per_scope": 10,
                          "client_messages_per_minute": null}]"""
                                .getBytes()));

        final group.gnometrading.md.Source source = securityMaster.getSource("PANDASCORE");

        assertEquals(group.gnometrading.md.SourceKind.VENDOR, source.kind());
        assertEquals(0, source.exchangeId());
        assertArrayEquals(new String[] {"esports"}, source.families());
        assertEquals(40, source.maxPerConnection());
        assertEquals("KEY", source.connectionScope());
        assertEquals(10, source.connectionsPerScope());
        assertEquals(0, source.clientMessagesPerMinute(), "no limit");
        assertSame(source, securityMaster.getSource(9));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testSourceAccountIsLookedUpEveryTimeSoARetirementIsSeen() {
        final ViewString path = new ViewString("/api/sources/accounts?sourceCode=KALSHI&label=md-1");
        when(registryConnection.get(path))
                .thenReturn(ByteBuffer.wrap(
                        """
                        [{"account_id": 3, "source_id": 4, "source_code": "KALSHI", "label": "md-1",
                          "secret_name": "gnome/market-data/kalshi/md-1", "connection_budget": null,
                          "status": "ACTIVE", "note": null, "created_by": "ops"}]"""
                                .getBytes()))
                .thenReturn(ByteBuffer.wrap(
                        """
                        [{"account_id": 3, "source_id": 4, "source_code": "KALSHI", "label": "md-1",
                          "secret_name": "gnome/market-data/kalshi/md-1", "connection_budget": 150,
                          "status": "RETIRED"}]"""
                                .getBytes()));

        final group.gnometrading.md.SourceAccount account = securityMaster.getSourceAccount("KALSHI", "md-1");
        assertEquals("gnome/market-data/kalshi/md-1", account.secretName());
        assertEquals(0, account.connectionBudget(), "the source's own limit");
        assertTrue(account.active());

        final group.gnometrading.md.SourceAccount later = securityMaster.getSourceAccount("KALSHI", "md-1");
        assertFalse(later.active());
        assertEquals(150, later.connectionBudget());
        verify(registryConnection, times(2)).get(any());
    }

    @Test
    void testAMissingSourceAccountIsNull() {
        when(registryConnection.get(new ViewString("/api/sources/accounts?sourceCode=KALSHI&label=md-9")))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));
        assertNull(securityMaster.getSourceAccount("KALSHI", "md-9"));
    }

    @Test
    void testStreamDirectoryResolvesStreamsListingsAndVenueIds() {
        when(registryConnection.get(new ViewString("/api/streams?listingId=789")))
                .thenReturn(ByteBuffer.wrap(LISTING_STREAM_JSON.getBytes()));
        when(registryConnection.get(new ViewString("/api/streams?streamId=40")))
                .thenReturn(ByteBuffer.wrap(
                        """
                        [{"stream_id": 40, "source_id": 9, "source_code": "PANDASCORE", "subject_kind": "MATCH",
                          "listing_id": null, "native_subject_id": "12345", "family": "esports", "active": true}]"""
                                .getBytes()));
        stubListing(789, 456, 123);

        final group.gnometrading.md.StreamDirectory directory =
                group.gnometrading.md.StreamDirectory.of(securityMaster, new int[] {789}, new int[] {40});

        assertEquals(789, directory.listingId(31));
        assertEquals(31, directory.streamId(789));
        assertEquals(789, directory.listingId(456, 123));
        assertEquals(group.gnometrading.md.StreamDirectory.NONE, directory.listingId(40));
        assertEquals(group.gnometrading.md.StreamDirectory.NONE, directory.listingId(456, 999));
        assertEquals("esports", directory.stream(40).family());
        assertEquals(789, directory.listing(789).listingId());
    }

    private void stubListing(int listingId, int exchangeId, int securityId) {
        when(registryConnection.get(new ViewString("/api/listings?listingId=" + listingId)))
                .thenReturn(ByteBuffer.wrap(
                        listingJson(listingId, exchangeId, securityId).getBytes()));
        stubExchangeAndSecurity(exchangeId, securityId);
    }

    private void stubListingByExchangeAndSecurity(int listingId, int exchangeId, int securityId) {
        when(registryConnection.get(
                        new ViewString("/api/listings?exchangeId=" + exchangeId + "&securityId=" + securityId)))
                .thenReturn(ByteBuffer.wrap(
                        listingJson(listingId, exchangeId, securityId).getBytes()));
        stubExchangeAndSecurity(exchangeId, securityId);
    }

    private void stubExchangeAndSecurity(int exchangeId, int securityId) {
        lenient()
                .when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=" + exchangeId)))
                .thenReturn(ByteBuffer.wrap(("[{\"exchange_id\": " + exchangeId
                                + ", \"exchange_code\": \"VENUE\", \"exchange_name\": \"Venue\", \"region\": \"us-east-1\""
                                + "}]")
                        .getBytes()));
        lenient()
                .when(registryConnection.get(new ViewString("/api/securities?securityId=" + securityId)))
                .thenReturn(ByteBuffer.wrap(
                        ("[{\"security_id\": " + securityId + ", \"type\": 0, \"symbol\": \"BTC\"}]").getBytes()));
    }

    private static String listingJson(int listingId, int exchangeId, int securityId) {
        return "[{\"listing_id\": " + listingId + ", \"exchange_id\": " + exchangeId + ", \"security_id\": "
                + securityId + ", \"exchange_security_id\": \"SecId\", \"exchange_security_symbol\": \"SYM\"}]";
    }

    @Test
    void testGetListingByIdCaching() {
        String listingResponse =
                """
                [{"listing_id": 789, "exchange_id": 456, "security_id": 123, "exchange_security_id": "SecId", "exchange_security_symbol": "SYM"}]""";
        String exchangeResponse =
                """
                [{"exchange_id": 456, "exchange_code": "NYSE_VENUE", "exchange_name": "NYSE", "region": "us-east-1"}]""";
        String securityResponse = """
                [{"security_id": 123, "type": 0, "symbol": "BTC"}]""";

        when(registryConnection.get(new ViewString("/api/listings?listingId=789")))
                .thenReturn(ByteBuffer.wrap(listingResponse.getBytes()));
        when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=456")))
                .thenReturn(ByteBuffer.wrap(exchangeResponse.getBytes()));
        when(registryConnection.get(new ViewString("/api/securities?securityId=123")))
                .thenReturn(ByteBuffer.wrap(securityResponse.getBytes()));

        Listing first = securityMaster.getListing(789);
        Listing second = securityMaster.getListing(789);

        assertSame(first, second);
        verify(registryConnection, times(3)).get(any()); // listing + exchange + security, only once each
    }

    @ParameterizedTest
    @MethodSource("testGetListingSpecArguments")
    void testGetListingSpec(final int listingId, final String jsonResponse, final ListingSpec expected) {
        when(registryConnection.get(
                        new ViewString("/api/listing-specs?listingId=" + listingId + "&from=1970-01-01T00:00:00Z")))
                .thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));
        assertEquals(expected, securityMaster.getListingSpec(listingId));
        verify(registryConnection, times(1)).get(any());
    }

    private static Stream<Arguments> testGetListingSpecArguments() {
        return Stream.of(
                Arguments.of(1, "[]", null),
                Arguments.of(
                        42,
                        """
                        [{"listing_id": 42, "tick_size": 100, "lot_size": 1000, "min_notional": 50000, "contract_multiplier": 1000000000, "min_size": 5000000}]""",
                        new ListingSpec(42, 100L, 1000L, 50000L, 1_000_000_000L, 5_000_000L)),
                Arguments.of(
                        99,
                        """
                        [{"listing_id": 99, "tick_size": 10, "lot_size": 100}]""",
                        new ListingSpec(99, 10L, 100L, 0L, 0L, 0L)));
    }

    @Test
    void testGetListingSpecCaching() {
        when(registryConnection.get(new ViewString("/api/listing-specs?listingId=42&from=1970-01-01T00:00:00Z")))
                .thenReturn(ByteBuffer.wrap(
                        "[{\"listing_id\": 42, \"tick_size\": 100, \"lot_size\": 1000, \"min_notional\": 0, \"contract_multiplier\": 1000000000}]"
                                .getBytes()));
        assertSame(securityMaster.getListingSpec(42), securityMaster.getListingSpec(42));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetListingSpecAtATime() {
        when(registryConnection.get(new ViewString("/api/listing-specs?listingId=42&from=1970-01-01T00:00:00Z")))
                .thenReturn(ByteBuffer.wrap(
                        """
                        [{"listing_id": 42, "tick_size": 10, "lot_size": 1, "effective_from": "1970-01-01T00:00:00.000Z"},
                         {"listing_id": 42, "tick_size": 100, "lot_size": 1, "effective_from": "2026-07-01T00:00:00.000Z"}]"""
                                .getBytes()));
        final long july = java.time.Instant.parse("2026-07-01T00:00:00Z").getEpochSecond() * 1_000_000_000L;

        assertEquals(10L, securityMaster.getListingSpec(42, july - 1).tickSize());
        assertEquals(100L, securityMaster.getListingSpec(42, july).tickSize());
        assertEquals(100L, securityMaster.getListingSpec(42).tickSize());
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetListingSpecBeforeItsFirstIsNull() {
        when(registryConnection.get(new ViewString("/api/listing-specs?listingId=42&from=1970-01-01T00:00:00Z")))
                .thenReturn(ByteBuffer.wrap(
                        """
                        [{"listing_id": 42, "tick_size": 10, "lot_size": 1, "effective_from": "2026-07-01T00:00:00.000Z"}]"""
                                .getBytes()));

        assertNull(securityMaster.getListingSpec(42, 0));
    }

    @Test
    void testGetFeeTimeline() {
        when(registryConnection.get(new ViewString("/api/fees?listingIds=7")))
                .thenReturn(ByteBuffer.wrap(
                        """
                        [{"listingId": 7, "timeline": [
                          {"effectiveFrom": "2026-04-03T04:00:00.000Z", "effectiveTo": "2026-07-01T04:00:00.000Z",
                           "scope": "EXCHANGE", "feeScheduleId": "1",
                           "definition": {"currency": "USD",
                             "components": [{"kind": "PRICE_CURVE", "taker": 0.05, "maker": -0.0125, "exponent": 1}],
                             "rounding": {"mode": "HALF_EVEN", "increment": 0.01, "scope": "FILL"}}},
                          {"effectiveFrom": "2026-07-01T04:00:00.000Z", "effectiveTo": null,
                           "scope": "EXCHANGE", "feeScheduleId": "2",
                           "definition": {"currency": "USD",
                             "components": [{"kind": "NOTIONAL", "taker": 0.00045, "maker": 0.00015}],
                             "rounding": {"mode": "NONE"}}}]}]"""
                                .getBytes()));
        final long april = java.time.Instant.parse("2026-04-03T04:00:00Z").getEpochSecond() * 1_000_000_000L;
        final long july = java.time.Instant.parse("2026-07-01T04:00:00Z").getEpochSecond() * 1_000_000_000L;

        final FeeTimeline timeline = securityMaster.getFeeTimeline(7);

        assertNull(timeline.at(april - 1));
        // 1 contract at $0.436, taker: 0.05 × 0.436 × 0.564 = $0.0123, half-even to the cent.
        assertEquals(10_000_000L, timeline.at(april).fee(true, 436_000_000L, 1_000_000L, false, null));
        assertEquals(45_000_000L, timeline.at(july).fee(true, 100_000_000_000L, 1_000_000L, false, null));
        assertSame(timeline, securityMaster.getFeeTimeline(7));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetFeeTimelineForAListingWithNoFees() {
        when(registryConnection.get(new ViewString("/api/fees?listingIds=7")))
                .thenReturn(ByteBuffer.wrap("[{\"listingId\": 7, \"timeline\": []}]".getBytes()));

        assertEquals(0, securityMaster.getFeeTimeline(7).size());
    }

    @Test
    void testGetFeeTimelineAsKnownAtAPinnedTime() {
        when(registryConnection.get(new ViewString("/api/fees?listingIds=7&knownAsOf=2026-10-01T00:00:00.000Z")))
                .thenReturn(ByteBuffer.wrap("[{\"listingId\": 7, \"timeline\": []}]".getBytes()));

        final FeeTimeline timeline = securityMaster.getFeeTimeline(7, "2026-10-01T00:00:00.000Z");

        assertEquals(0, timeline.size());
        assertSame(timeline, securityMaster.getFeeTimeline(7, "2026-10-01T00:00:00.000Z"));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetSimulationParameters() {
        when(registryConnection.get(
                        new ViewString("/api/simulation-parameters?exchangeId=3&knownAsOf=2026-10-01T00:00:00.000Z")))
                .thenReturn(ByteBuffer.wrap(
                        """
                        [{"simulation_parameters_id": "12", "exchange_id": 3, "recorded_at": "2026-09-30T00:00:00.000Z",
                          "note": null, "actor": "migration 044",
                          "definition": {"queue_model": {"type": "risk_averse"}}}]"""
                                .getBytes()));

        final SimulationParameters parameters = securityMaster.getSimulationParameters(3, "2026-10-01T00:00:00.000Z");

        assertEquals(12L, parameters.simulationParametersId());
        assertEquals(3, parameters.exchangeId());
        assertEquals("2026-09-30T00:00:00.000Z", parameters.recordedAt());
        assertEquals("{\"queue_model\":{\"type\":\"risk_averse\"}}", parameters.definition());
        assertSame(parameters, securityMaster.getSimulationParameters(3, "2026-10-01T00:00:00.000Z"));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetExchangeByCode() {
        when(registryConnection.get(new ViewString("/api/exchanges?exchangeCode=KALSHI")))
                .thenReturn(ByteBuffer.wrap(
                        "[{\"exchange_id\": 3, \"exchange_code\": \"KALSHI\", \"exchange_name\": \"Kalshi\"}]"
                                .getBytes()));
        when(registryConnection.get(new ViewString("/api/exchanges?exchangeCode=POLYMARKET")))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));

        assertEquals(3, securityMaster.getExchange("KALSHI").exchangeId());
        assertNull(securityMaster.getExchange("POLYMARKET"));
        assertNull(securityMaster.getExchange("POLYMARKET"));
        securityMaster.getExchange("KALSHI");
        verify(registryConnection, times(2)).get(any());
    }

    @Test
    void testGetSimulationParametersForAnExchangeWithNone() {
        when(registryConnection.get(
                        new ViewString("/api/simulation-parameters?exchangeId=3&knownAsOf=2026-10-01T00:00:00.000Z")))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));

        assertNull(securityMaster.getSimulationParameters(3, "2026-10-01T00:00:00.000Z"));
        assertNull(securityMaster.getSimulationParameters(3, "2026-10-01T00:00:00.000Z"));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetSecurityEmptyCaching() {
        when(registryConnection.get(new ViewString("/api/securities?securityId=1")))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));

        assertNull(securityMaster.getSecurity(1));
        assertNull(securityMaster.getSecurity(1));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetExchangeEmptyCaching() {
        when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=1")))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));

        assertNull(securityMaster.getExchange(1));
        assertNull(securityMaster.getExchange(1));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetListingSpecEmptyCaching() {
        when(registryConnection.get(new ViewString("/api/listing-specs?listingId=1&from=1970-01-01T00:00:00Z")))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));

        assertNull(securityMaster.getListingSpec(1));
        assertNull(securityMaster.getListingSpec(1));
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetListingByExchangeAndSecurityCaching() {
        String listingResponse =
                """
                [{"listing_id": 789, "exchange_id": 456, "security_id": 123, "exchange_security_id": "SecId", "exchange_security_symbol": "SYM"}]""";
        String exchangeResponse =
                """
                [{"exchange_id": 456, "exchange_code": "NYSE_VENUE", "exchange_name": "NYSE", "region": "us-east-1"}]""";
        String securityResponse = """
                [{"security_id": 123, "type": 0, "symbol": "BTC"}]""";

        when(registryConnection.get(new ViewString("/api/listings?exchangeId=456&securityId=123")))
                .thenReturn(ByteBuffer.wrap(listingResponse.getBytes()));
        when(registryConnection.get(new ViewString("/api/exchanges?exchangeId=456")))
                .thenReturn(ByteBuffer.wrap(exchangeResponse.getBytes()));
        when(registryConnection.get(new ViewString("/api/securities?securityId=123")))
                .thenReturn(ByteBuffer.wrap(securityResponse.getBytes()));

        Listing first = securityMaster.getListing(456, 123);
        Listing second = securityMaster.getListing(456, 123);

        assertSame(first, second);
        verify(registryConnection, times(3)).get(any()); // listing + exchange + security, only once each
    }

    @Test
    void testGetAllContractRelationships() {
        String json =
                """
                [{"relationship_id": 1, "security_id_a": 100, "security_id_b": 200,
                  "relationship_type": "EQUIVALENT", "confidence": 0.95, "method": "semantic"}]""";
        when(registryConnection.get(new ViewString("/api/contract-relationships?")))
                .thenReturn(ByteBuffer.wrap(json.getBytes()));

        ContractRelationship[] result = securityMaster.getAllContractRelationships();
        assertEquals(1, result.length);
        assertEquals(1, result[0].relationshipId());
        assertEquals(100, result[0].securityIdA());
        assertEquals(200, result[0].securityIdB());
        assertEquals("EQUIVALENT", result[0].relationshipType());
        assertEquals(0.95f, result[0].confidence(), 0.001f);
        assertEquals("semantic", result[0].method());
    }

    @Test
    void testGetAllContractRelationshipsEmpty() {
        when(registryConnection.get(new ViewString("/api/contract-relationships?")))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));
        ContractRelationship[] result = securityMaster.getAllContractRelationships();
        assertEquals(0, result.length);
    }

    @Test
    void testGetAllContractRelationshipsCaching() {
        String json =
                """
                [{"relationship_id": 1, "security_id_a": 100, "security_id_b": 200,
                  "relationship_type": "EQUIVALENT", "confidence": 0.95, "method": "semantic"}]""";
        when(registryConnection.get(new ViewString("/api/contract-relationships?")))
                .thenReturn(ByteBuffer.wrap(json.getBytes()));

        ContractRelationship[] first = securityMaster.getAllContractRelationships();
        ContractRelationship[] second = securityMaster.getAllContractRelationships();

        assertSame(first, second);
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetContractRelationships() {
        String json =
                """
                [{"relationship_id": 2, "security_id_a": 100, "security_id_b": 300,
                  "relationship_type": "COMPLEMENT", "confidence": 1.0, "method": "structural"}]""";
        when(registryConnection.get(new ViewString("/api/contract-relationships?securityId=100")))
                .thenReturn(ByteBuffer.wrap(json.getBytes()));

        ContractRelationship[] result = securityMaster.getContractRelationships(100);
        assertEquals(1, result.length);
        assertEquals(2, result[0].relationshipId());
        assertEquals("COMPLEMENT", result[0].relationshipType());
        verify(registryConnection, times(1)).get(any());
    }

    @Test
    void testGetContractRelationshipsEmpty() {
        when(registryConnection.get(new ViewString("/api/contract-relationships?securityId=999")))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));
        ContractRelationship[] result = securityMaster.getContractRelationships(999);
        assertEquals(0, result.length);
    }

    @Test
    void testGetSecurityAllFields() {
        String jsonResponse =
                """
                [{"security_id": 5, "symbol": "BTC-USDT-PERP", "type": 1, "contract_type": 1, \
"asset_class": 0, "base_currency": "BTC", "quote_currency": "USDT", "settle_currency": "USDT", \
"inverse": false, "is_quanto": false, "contract_multiplier": 1000000000, "active": true, \
"underlying_security_id": 0}]""";
        when(registryConnection.get(new ViewString("/api/securities?securityId=5")))
                .thenReturn(ByteBuffer.wrap(jsonResponse.getBytes()));

        Security result = securityMaster.getSecurity(5);

        assertNotNull(result);
        assertEquals(5, result.securityId());
        assertEquals("BTC-USDT-PERP", result.symbol());
        assertEquals(SecurityType.PERPETUAL, result.type());
        assertEquals(ContractType.LINEAR_PERPETUAL, result.contractType());
        assertEquals(AssetClass.CRYPTO, result.assetClass());
        assertEquals("BTC", result.baseCurrency());
        assertEquals("USDT", result.quoteCurrency());
        assertEquals("USDT", result.settleCurrency());
        assertTrue(result.active());
    }
}
