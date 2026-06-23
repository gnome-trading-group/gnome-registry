package group.gnometrading;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import group.gnometrading.collections.IntHashMap;
import group.gnometrading.collections.IntMap;
import group.gnometrading.sm.AssetClass;
import group.gnometrading.sm.ContractType;
import group.gnometrading.sm.Event;
import group.gnometrading.sm.EventContract;
import group.gnometrading.sm.Exchange;
import group.gnometrading.sm.Listing;
import group.gnometrading.sm.ListingSpec;
import group.gnometrading.sm.Security;
import group.gnometrading.sm.SecurityType;
import group.gnometrading.strings.ExpandingMutableString;
import group.gnometrading.strings.MutableString;
import java.io.IOException;
import java.nio.ByteBuffer;

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

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

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
    private static final Exchange EMPTY_EXCHANGE = new Exchange(-1, null, null, null);
    private static final ListingSpec EMPTY_LISTING_SPEC = new ListingSpec(-1, -1, -1, -1, 0L);
    private static final Event EMPTY_EVENT = new Event(-1, null, null, null, null, false, 0L, 0L);
    private static final EventContract EMPTY_EVENT_CONTRACT = new EventContract(-1, -1, -1, null);

    private final RegistryConnection registryConnection;

    private final MutableString securityPath;
    private final MutableString exchangePath;
    private final MutableString listingPath;
    private final MutableString listingSpecPath;
    private final MutableString eventPath;
    private final MutableString eventContractPath;

    private final IntMap<Security> securityCache;
    private final IntMap<Exchange> exchangeCache;
    private final IntMap<Listing> listingCache;
    private final IntMap<ListingSpec> listingSpecCache;
    private final IntMap<Event> eventCache;
    private final IntMap<EventContract> eventContractBySecurityCache;

    public SecurityMaster(final RegistryConnection registryConnection) {
        this.registryConnection = registryConnection;

        this.securityPath = new ExpandingMutableString(SECURITY_ENDPOINT);
        this.exchangePath = new ExpandingMutableString(EXCHANGE_ENDPOINT);
        this.listingPath = new ExpandingMutableString(LISTING_ENDPOINT);
        this.listingSpecPath = new ExpandingMutableString(LISTING_SPEC_ENDPOINT);
        this.eventPath = new ExpandingMutableString(EVENT_ENDPOINT);
        this.eventContractPath = new ExpandingMutableString(EVENT_CONTRACT_ENDPOINT);

        this.securityCache = new IntHashMap<>();
        this.exchangeCache = new IntHashMap<>();
        this.listingCache = new IntHashMap<>();
        this.listingSpecCache = new IntHashMap<>();
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

    public Listing getListing(final int exchangeId, final int securityId) {
        for (int listingId : this.listingCache.keys()) {
            final Listing listing = this.listingCache.get(listingId);
            if (listing.exchange().exchangeId() == exchangeId
                    && listing.security().securityId() == securityId) {
                return listing;
            }
        }

        final int originalLength = addParameters(this.listingPath, "exchangeId", exchangeId, "securityId", securityId);
        final ByteBuffer response = this.registryConnection.get(this.listingPath);
        this.listingPath.setLength(originalLength);

        final Listing listing = parseListing(response);
        if (listing != null) {
            this.listingCache.put(listing.listingId(), listing);
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

        this.listingCache.put(listingId, parseListing(response));
        return this.listingCache.get(listingId);
    }

    public ListingSpec getListingSpec(final int listingId) {
        if (this.listingSpecCache.containsKey(listingId)) {
            final ListingSpec cached = this.listingSpecCache.get(listingId);
            return cached == EMPTY_LISTING_SPEC ? null : cached;
        }

        final int originalLength = addParameters(this.listingSpecPath, "listingId", listingId);
        final ByteBuffer response = this.registryConnection.get(this.listingSpecPath);
        this.listingSpecPath.setLength(originalLength);

        try {
            final ListingSpec[] result = OBJECT_MAPPER.readValue(toByteArray(response), ListingSpec[].class);
            if (result.length == 0) {
                this.listingSpecCache.put(listingId, EMPTY_LISTING_SPEC);
                return null;
            }
            this.listingSpecCache.put(listingId, result[0]);
            return this.listingSpecCache.get(listingId);
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
