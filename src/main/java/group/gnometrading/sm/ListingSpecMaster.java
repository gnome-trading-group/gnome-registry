package group.gnometrading.sm;

import group.gnometrading.RegistryConnection;
import group.gnometrading.codecs.json.JsonDecoder;
import group.gnometrading.collections.IntHashMap;
import group.gnometrading.collections.IntMap;
import group.gnometrading.strings.ExpandingMutableString;
import group.gnometrading.strings.MutableString;
import java.nio.ByteBuffer;

/**
 * ListingSpecMaster caches tick/lot size data per listing.
 * Produces garbage on first fetch; zero-allocation on cache hits.
 */
public final class ListingSpecMaster {

    private static final String LISTING_SPEC_ENDPOINT = "/api/listing-specs?";

    private final JsonDecoder jsonDecoder;
    private final RegistryConnection registryConnection;

    private final MutableString listingSpecPath;
    private final IntMap<ListingSpec> listingSpecCache;

    public ListingSpecMaster(final RegistryConnection registryConnection) {
        this.registryConnection = registryConnection;
        this.jsonDecoder = new JsonDecoder();
        this.listingSpecPath = new ExpandingMutableString(LISTING_SPEC_ENDPOINT);
        this.listingSpecCache = new IntHashMap<>();
    }

    @SuppressWarnings("checkstyle:NestedTryDepth")
    public ListingSpec getListingSpec(final int listingId) {
        if (this.listingSpecCache.containsKey(listingId)) {
            return this.listingSpecCache.get(listingId);
        }

        final int originalLength = addParameter(this.listingSpecPath, "listingId", listingId);
        final ByteBuffer response = this.registryConnection.get(this.listingSpecPath);
        this.listingSpecPath.setLength(originalLength);

        try (var node = this.jsonDecoder.wrap(response)) {
            try (var array = node.asArray()) {
                if (!array.hasNextItem()) {
                    return null;
                }

                int parsedListingId = -1;
                long tickSize = -1;
                long lotSize = -1;
                long minNotional = 0;

                try (var item = array.nextItem()) {
                    try (var object = item.asObject()) {
                        while (object.hasNextKey()) {
                            try (var key = object.nextKey()) {
                                if (key.getName().equals("listing_id")) {
                                    parsedListingId = key.asInt();
                                } else if (key.getName().equals("tick_size")) {
                                    tickSize = key.asLong();
                                } else if (key.getName().equals("lot_size")) {
                                    lotSize = key.asLong();
                                } else if (key.getName().equals("min_notional")) {
                                    minNotional = key.asLong();
                                }
                            }
                        }
                    }
                }
                this.listingSpecCache.put(listingId, new ListingSpec(parsedListingId, tickSize, lotSize, minNotional));
                return this.listingSpecCache.get(listingId);
            }
        }
    }

    private int addParameter(final MutableString string, final String paramName, final int value) {
        int originalLength = string.length();
        string.appendString(paramName);
        string.append((byte) '=');
        string.appendNaturalIntAscii(value);
        return originalLength;
    }
}
