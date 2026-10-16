package group.gnometrading;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import group.gnometrading.collections.IntHashMap;
import group.gnometrading.collections.IntMap;
import group.gnometrading.collections.LongHashMap;
import group.gnometrading.collections.LongMap;
import group.gnometrading.sm.AssetClass;
import group.gnometrading.sm.ContractRelationship;
import group.gnometrading.sm.ContractType;
import group.gnometrading.sm.Event;
import group.gnometrading.sm.EventContract;
import group.gnometrading.sm.Exchange;
import group.gnometrading.sm.Listing;
import group.gnometrading.sm.ListingSpec;
import group.gnometrading.sm.Security;
import group.gnometrading.sm.SecurityType;
import group.gnometrading.sm.SimulationParameters;
import group.gnometrading.sm.fee.FeeTimeline;
import group.gnometrading.sm.fee.FeeTimelineJson;
import group.gnometrading.strings.ExpandingMutableString;
import group.gnometrading.strings.MutableString;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.Map;

/**
 * SecurityMaster is an abstraction for the database security master layer.
 * These class will produce garbage when fetching from the API.
 */
public final class SecurityMaster {

    private static final String SECURITY_ENDPOINT = "/api/securities?";
    private static final String EXCHANGE_ENDPOINT = "/api/exchanges?";
    private static final String LISTING_ENDPOINT = "/api/listings?";
    private static final String LISTING_SPEC_ENDPOINT = "/api/listing-specs?";
    private static final String EVENT_ENDPOINT = "/api/events?";
    private static final String EVENT_CONTRACT_ENDPOINT = "/api/event-contracts?";
    private static final String CONTRACT_RELATIONSHIP_ENDPOINT = "/api/contract-relationships?";
    private static final String FEE_ENDPOINT = "/api/fees?";
    private static final String SIMULATION_PARAMETERS_ENDPOINT = "/api/simulation-parameters?";
    // Every spec a listing has had, each from when it held at the venue.
    private static final String SPEC_HISTORY_PARAMETER = "&from=1970-01-01T00:00:00Z";
    private static final long NANOS_PER_MILLI = 1_000_000L;

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ListingSpecRow(
            int listingId,
            long tickSize,
            long lotSize,
            long minNotional,
            long contractMultiplier,
            long minSize,
            String effectiveFrom) {}

    /** A listing's specs in effective order; each holds from its start until the next one's. */
    private record ListingSpecHistory(long[] startNanos, ListingSpec[] specs) {
        ListingSpec at(final long nanos) {
            ListingSpec spec = null;
            for (int i = 0; i < this.startNanos.length && this.startNanos[i] <= nanos; i++) {
                spec = this.specs[i];
            }
            return spec;
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record SimulationParametersRow(
            long simulationParametersId, int exchangeId, String recordedAt, JsonNode definition) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ListingResponse(
            int listingId, int exchangeId, int securityId, String exchangeSecurityId, String exchangeSecuritySymbol) {}

    private static final Security EMPTY_SECURITY = new Security(
            -1,
            null,
            SecurityType.SPOT,
            ContractType.NONE,
            AssetClass.CRYPTO,
            null,
            null,
            null,
            false,
            false,
            0L,
            0L,
            false,
            0);
    private static final Exchange EMPTY_EXCHANGE = new Exchange(-1, null, null, null, null);
    private static final ListingSpecHistory NO_SPECS = new ListingSpecHistory(new long[0], new ListingSpec[0]);
    private static final Event EMPTY_EVENT = new Event(-1, null, null, null, false, 0L, 0L);
    private static final SimulationParameters NO_SIMULATION_PARAMETERS = new SimulationParameters(-1, -1, null, null);
    private static final EventContract EMPTY_EVENT_CONTRACT = new EventContract(-1, -1, -1, null);

    private final RegistryConnection registryConnection;

    private final MutableString securityPath;
    private final MutableString exchangePath;
    private final MutableString listingPath;
    private final MutableString listingSpecPath;
    private final MutableString eventPath;
    private final MutableString eventContractPath;
    private final MutableString contractRelationshipPath;
    private final MutableString feePath;
    private final MutableString simulationParametersPath;

    private final IntMap<Security> securityCache;
    private final IntMap<Exchange> exchangeCache;
    private final IntMap<Listing> listingCache;
    private final LongMap<Listing> listingByExchangeSecurity;
    private final IntMap<ListingSpecHistory> listingSpecCache;
    private final IntMap<FeeTimeline> feeTimelineCache;
    // Keyed by the knowledge time a run pinned, then by listing or exchange: one process normally pins one time.
    private final Map<String, IntMap<FeeTimeline>> pinnedFeeTimelineCache;
    private final Map<String, IntMap<SimulationParameters>> simulationParametersCache;
    private final Map<String, Exchange> exchangeByCodeCache;
    private final IntMap<Event> eventCache;
    private final IntMap<EventContract> eventContractBySecurityCache;

    private ContractRelationship[] allContractRelationships;

    public SecurityMaster(final RegistryConnection registryConnection) {
        this.registryConnection = registryConnection;

        this.securityPath = new ExpandingMutableString(SECURITY_ENDPOINT);
        this.exchangePath = new ExpandingMutableString(EXCHANGE_ENDPOINT);
        this.listingPath = new ExpandingMutableString(LISTING_ENDPOINT);
        this.listingSpecPath = new ExpandingMutableString(LISTING_SPEC_ENDPOINT);
        this.eventPath = new ExpandingMutableString(EVENT_ENDPOINT);
        this.eventContractPath = new ExpandingMutableString(EVENT_CONTRACT_ENDPOINT);
        this.contractRelationshipPath = new ExpandingMutableString(CONTRACT_RELATIONSHIP_ENDPOINT);
        this.feePath = new ExpandingMutableString(FEE_ENDPOINT);
        this.simulationParametersPath = new ExpandingMutableString(SIMULATION_PARAMETERS_ENDPOINT);

        this.securityCache = new IntHashMap<>();
        this.exchangeCache = new IntHashMap<>();
        this.listingCache = new IntHashMap<>();
        this.listingByExchangeSecurity = new LongHashMap<>();
        this.listingSpecCache = new IntHashMap<>();
        this.feeTimelineCache = new IntHashMap<>();
        this.pinnedFeeTimelineCache = new HashMap<>();
        this.simulationParametersCache = new HashMap<>();
        this.exchangeByCodeCache = new HashMap<>();
        this.eventCache = new IntHashMap<>();
        this.eventContractBySecurityCache = new IntHashMap<>();
    }

    public Security getSecurity(final int securityId) {
        if (this.securityCache.containsKey(securityId)) {
            final Security cached = this.securityCache.get(securityId);
            return cached == EMPTY_SECURITY ? null : cached;
        }

        final int originalLength = addParameters(this.securityPath, "securityId", securityId);
        final ByteBuffer response = this.registryConnection.get(this.securityPath);
        this.securityPath.setLength(originalLength);

        try {
            final Security[] result = OBJECT_MAPPER.readValue(toByteArray(response), Security[].class);
            if (result.length == 0) {
                this.securityCache.put(securityId, EMPTY_SECURITY);
                return null;
            }
            this.securityCache.put(securityId, result[0]);
            return this.securityCache.get(securityId);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    public Exchange getExchange(final int exchangeId) {
        if (this.exchangeCache.containsKey(exchangeId)) {
            final Exchange cached = this.exchangeCache.get(exchangeId);
            return cached == EMPTY_EXCHANGE ? null : cached;
        }

        final int originalLength = addParameters(this.exchangePath, "exchangeId", exchangeId);
        final ByteBuffer response = this.registryConnection.get(this.exchangePath);
        this.exchangePath.setLength(originalLength);

        try {
            final Exchange[] result = OBJECT_MAPPER.readValue(toByteArray(response), Exchange[].class);
            if (result.length == 0) {
                this.exchangeCache.put(exchangeId, EMPTY_EXCHANGE);
                return null;
            }
            this.exchangeCache.put(exchangeId, result[0]);
            return this.exchangeCache.get(exchangeId);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    /** The exchange with this code (e.g. KALSHI), or null if there is none. */
    public Exchange getExchange(final String exchangeCode) {
        final Exchange cached = this.exchangeByCodeCache.get(exchangeCode);
        if (cached != null) {
            return cached == EMPTY_EXCHANGE ? null : cached;
        }
        final int originalLength = this.exchangePath.length();
        this.exchangePath.appendString("exchangeCode=");
        this.exchangePath.appendString(exchangeCode);
        final ByteBuffer response = this.registryConnection.get(this.exchangePath);
        this.exchangePath.setLength(originalLength);

        try {
            final Exchange[] result = OBJECT_MAPPER.readValue(toByteArray(response), Exchange[].class);
            final Exchange exchange = result.length == 0 ? EMPTY_EXCHANGE : result[0];
            this.exchangeByCodeCache.put(exchangeCode, exchange);
            return exchange == EMPTY_EXCHANGE ? null : exchange;
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    public Listing getListing(final int exchangeId, final int securityId) {
        final Listing cached = this.listingByExchangeSecurity.get(exchangeSecurityKey(exchangeId, securityId));
        if (cached != null) {
            return cached;
        }

        final int originalLength = addParameters(this.listingPath, "exchangeId", exchangeId, "securityId", securityId);
        final ByteBuffer response = this.registryConnection.get(this.listingPath);
        this.listingPath.setLength(originalLength);

        final Listing listing = parseListing(response);
        if (listing != null) {
            cacheListing(listing);
        }
        return listing;
    }

    public Listing getListing(final int listingId) {
        if (this.listingCache.containsKey(listingId)) {
            return this.listingCache.get(listingId);
        }

        final int originalLength = addParameters(this.listingPath, "listingId", listingId);
        final ByteBuffer response = this.registryConnection.get(this.listingPath);
        this.listingPath.setLength(originalLength);

        final Listing listing = parseListing(response);
        if (listing == null) {
            this.listingCache.put(listingId, null);
        } else {
            cacheListing(listing);
        }
        return listing;
    }

    private void cacheListing(final Listing listing) {
        this.listingCache.put(listing.listingId(), listing);
        this.listingByExchangeSecurity.put(
                exchangeSecurityKey(
                        listing.exchange().exchangeId(), listing.security().securityId()),
                listing);
    }

    private static long exchangeSecurityKey(final int exchangeId, final int securityId) {
        return ((long) exchangeId << Integer.SIZE) | Integer.toUnsignedLong(securityId);
    }

    /** The listing's spec in force now. */
    public ListingSpec getListingSpec(final int listingId) {
        return getListingSpec(listingId, System.currentTimeMillis() * NANOS_PER_MILLI);
    }

    /**
     * The listing's spec in force at {@code epochNanos}, or null if it had none yet. A listing's whole history is
     * fetched once, so a backtest sees each spec only from when it held at the venue.
     */
    public ListingSpec getListingSpec(final int listingId, final long epochNanos) {
        ListingSpecHistory history = this.listingSpecCache.get(listingId);
        if (history == null) {
            history = fetchListingSpecs(listingId);
            this.listingSpecCache.put(listingId, history);
        }
        return history.at(epochNanos);
    }

    private ListingSpecHistory fetchListingSpecs(final int listingId) {
        final int originalLength = addParameters(this.listingSpecPath, "listingId", listingId);
        this.listingSpecPath.appendString(SPEC_HISTORY_PARAMETER);
        final ByteBuffer response = this.registryConnection.get(this.listingSpecPath);
        this.listingSpecPath.setLength(originalLength);

        try {
            final ListingSpecRow[] rows = OBJECT_MAPPER.readValue(toByteArray(response), ListingSpecRow[].class);
            if (rows.length == 0) {
                return NO_SPECS;
            }
            final long[] starts = new long[rows.length];
            final ListingSpec[] specs = new ListingSpec[rows.length];
            for (int i = 0; i < rows.length; i++) {
                final ListingSpecRow row = rows[i];
                starts[i] = row.effectiveFrom() == null ? 0 : FeeTimelineJson.epochNanos(row.effectiveFrom());
                specs[i] = new ListingSpec(
                        row.listingId(),
                        row.tickSize(),
                        row.lotSize(),
                        row.minNotional(),
                        row.contractMultiplier(),
                        row.minSize());
            }
            return new ListingSpecHistory(starts, specs);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    /** The listing's fee schedules over time, as the registry resolves them now; empty if it has none. */
    public FeeTimeline getFeeTimeline(final int listingId) {
        final FeeTimeline cached = this.feeTimelineCache.get(listingId);
        if (cached != null) {
            return cached;
        }
        final FeeTimeline timeline = fetchFeeTimeline(listingId, null);
        this.feeTimelineCache.put(listingId, timeline);
        return timeline;
    }

    /**
     * The listing's fee schedules over time as the registry knew them at {@code knownAsOf} (ISO-8601), ignoring
     * corrections recorded later, so a replayed run charges the fees the original did.
     */
    public FeeTimeline getFeeTimeline(final int listingId, final String knownAsOf) {
        final IntMap<FeeTimeline> pinned =
                this.pinnedFeeTimelineCache.computeIfAbsent(knownAsOf, k -> new IntHashMap<>());
        FeeTimeline timeline = pinned.get(listingId);
        if (timeline == null) {
            timeline = fetchFeeTimeline(listingId, knownAsOf);
            pinned.put(listingId, timeline);
        }
        return timeline;
    }

    private FeeTimeline fetchFeeTimeline(final int listingId, final String knownAsOf) {
        final int originalLength = addParameters(this.feePath, "listingIds", listingId);
        if (knownAsOf != null) {
            this.feePath.appendString("&knownAsOf=");
            this.feePath.appendString(knownAsOf);
        }
        final ByteBuffer response = this.registryConnection.get(this.feePath);
        this.feePath.setLength(originalLength);

        try {
            return FeeTimelineJson.parse(toByteArray(response), listingId);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * The exchange's simulation parameters in force at {@code knownAsOf} (ISO-8601): the latest version recorded by
     * then. Null if none had been recorded.
     */
    public SimulationParameters getSimulationParameters(final int exchangeId, final String knownAsOf) {
        final IntMap<SimulationParameters> pinned =
                this.simulationParametersCache.computeIfAbsent(knownAsOf, k -> new IntHashMap<>());
        final SimulationParameters cached = pinned.get(exchangeId);
        if (cached != null) {
            return cached == NO_SIMULATION_PARAMETERS ? null : cached;
        }
        final int originalLength = addParameters(this.simulationParametersPath, "exchangeId", exchangeId);
        this.simulationParametersPath.appendString("&knownAsOf=");
        this.simulationParametersPath.appendString(knownAsOf);
        final ByteBuffer response = this.registryConnection.get(this.simulationParametersPath);
        this.simulationParametersPath.setLength(originalLength);

        try {
            final SimulationParametersRow[] rows =
                    OBJECT_MAPPER.readValue(toByteArray(response), SimulationParametersRow[].class);
            if (rows.length == 0) {
                pinned.put(exchangeId, NO_SIMULATION_PARAMETERS);
                return null;
            }
            final SimulationParameters parameters = new SimulationParameters(
                    rows[0].simulationParametersId(),
                    rows[0].exchangeId(),
                    rows[0].recordedAt(),
                    rows[0].definition().toString());
            pinned.put(exchangeId, parameters);
            return parameters;
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    public Event getEvent(final int eventId) {
        if (this.eventCache.containsKey(eventId)) {
            final Event cached = this.eventCache.get(eventId);
            return cached == EMPTY_EVENT ? null : cached;
        }

        final int originalLength = addParameters(this.eventPath, "eventId", eventId);
        final ByteBuffer response = this.registryConnection.get(this.eventPath);
        this.eventPath.setLength(originalLength);

        try {
            final Event[] result = OBJECT_MAPPER.readValue(toByteArray(response), Event[].class);
            if (result.length == 0) {
                this.eventCache.put(eventId, EMPTY_EVENT);
                return null;
            }
            this.eventCache.put(eventId, result[0]);
            return this.eventCache.get(eventId);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    public EventContract getEventContractBySecurity(final int securityId) {
        if (this.eventContractBySecurityCache.containsKey(securityId)) {
            final EventContract cached = this.eventContractBySecurityCache.get(securityId);
            return cached == EMPTY_EVENT_CONTRACT ? null : cached;
        }

        final int originalLength = addParameters(this.eventContractPath, "securityId", securityId);
        final ByteBuffer response = this.registryConnection.get(this.eventContractPath);
        this.eventContractPath.setLength(originalLength);

        try {
            final EventContract[] result = OBJECT_MAPPER.readValue(toByteArray(response), EventContract[].class);
            if (result.length == 0) {
                this.eventContractBySecurityCache.put(securityId, EMPTY_EVENT_CONTRACT);
                return null;
            }
            this.eventContractBySecurityCache.put(securityId, result[0]);
            return this.eventContractBySecurityCache.get(securityId);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    public ContractRelationship[] getAllContractRelationships() {
        if (this.allContractRelationships != null) {
            return this.allContractRelationships;
        }

        final ByteBuffer response = this.registryConnection.get(this.contractRelationshipPath);

        try {
            this.allContractRelationships =
                    OBJECT_MAPPER.readValue(toByteArray(response), ContractRelationship[].class);
            return this.allContractRelationships;
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    public ContractRelationship[] getContractRelationships(final int securityId) {
        final int originalLength = addParameters(this.contractRelationshipPath, "securityId", securityId);
        final ByteBuffer response = this.registryConnection.get(this.contractRelationshipPath);
        this.contractRelationshipPath.setLength(originalLength);

        try {
            return OBJECT_MAPPER.readValue(toByteArray(response), ContractRelationship[].class);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    private Listing parseListing(final ByteBuffer response) {
        try {
            final ListingResponse[] result = OBJECT_MAPPER.readValue(toByteArray(response), ListingResponse[].class);
            if (result.length == 0) {
                return null;
            }
            final ListingResponse r = result[0];
            return new Listing(
                    r.listingId(),
                    getExchange(r.exchangeId()),
                    getSecurity(r.securityId()),
                    r.exchangeSecurityId(),
                    r.exchangeSecuritySymbol());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    private static byte[] toByteArray(final ByteBuffer buffer) {
        final byte[] bytes = new byte[buffer.remaining()];
        buffer.get(bytes);
        return bytes;
    }

    private int addParameters(final MutableString string, final String paramName, final int value) {
        int originalLength = string.length();
        string.appendString(paramName);
        string.append((byte) '=');
        string.appendNaturalIntAscii(value);
        return originalLength;
    }

    private int addParameters(
            final MutableString string,
            final String paramName1,
            final int value1,
            final String paramName2,
            final int value2) {
        int originalLength = addParameters(string, paramName1, value1);
        string.append((byte) '&');
        addParameters(string, paramName2, value2);
        return originalLength;
    }
}
