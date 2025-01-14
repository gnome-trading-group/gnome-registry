package group.gnometrading;

import group.gnometrading.codecs.json.JSONDecoder;
import group.gnometrading.collections.IntHashMap;
import group.gnometrading.collections.IntMap;
import group.gnometrading.sm.Exchange;
import group.gnometrading.sm.Listing;
import group.gnometrading.sm.Security;
import group.gnometrading.strings.ExpandingMutableString;
import group.gnometrading.strings.MutableString;

import java.nio.ByteBuffer;

/**
 * SecurityMaster is an abstraction for the database security master layer.
 * These class will produce garbage when fetching from the API. It is *not* thread safe.
 */
public class SecurityMaster {

    private static final String SECURITY_ENDPOINT = "/securities?";
    private static final String EXCHANGE_ENDPOINT = "/exchanges?";
    private static final String LISTING_ENDPOINT = "/listings?";

    private final IntMap<Security> securityMap;
    private final IntMap<Exchange> exchangeMap;
    private final IntMap<Listing> listingMap;
    private final JSONDecoder jsonDecoder;
    private final RegistryConnection registryConnection;

    private final MutableString securityPath;
    private final MutableString exchangePath;
    private final MutableString listingPath;

    public SecurityMaster(final RegistryConnection registryConnection) {
        this.registryConnection = registryConnection;
        this.securityMap = new IntHashMap<>();
        this.exchangeMap = new IntHashMap<>();
        this.listingMap = new IntHashMap<>();
        this.jsonDecoder = new JSONDecoder();

        this.securityPath = new ExpandingMutableString(SECURITY_ENDPOINT);
        this.exchangePath = new ExpandingMutableString(EXCHANGE_ENDPOINT);
        this.listingPath = new ExpandingMutableString(LISTING_ENDPOINT);
    }

    public Security getSecurity(final int securityId) {
        if (!this.securityMap.containsKey(securityId)) {
            final int originalLength = addParameters(this.securityPath, "securityId", securityId);
            final ByteBuffer response = this.registryConnection.get(this.securityPath);
            this.securityPath.setLength(originalLength);

            try (final var node = this.jsonDecoder.wrap(response)) {
                try (final var array = node.asArray()) {
                    if (!array.hasNextItem()) {
                        return null;
                    }

                    int type = -1;
                    String symbol = null;

                    try (final var item = array.nextItem()) {
                        try (final var object = item.asObject()) {
                            while (object.hasNextKey()) {
                                try (final var key = object.nextKey()) {
                                    if (key.getName().equals("symbol")) {
                                        symbol = key.asString().toString();
                                    } else if (key.getName().equals("type")) {
                                        type = key.asInt();
                                    }
                                }
                            }
                        }
                    }
                    this.securityMap.put(securityId, new Security(securityId, symbol, type));
                }
            }
        }

        return this.securityMap.get(securityId);
    }

    public Exchange getExchange(final int exchangeId) {
        if (!this.exchangeMap.containsKey(exchangeId)) {
            final int originalLength = addParameters(this.exchangePath, "exchangeId", exchangeId);
            final ByteBuffer response = this.registryConnection.get(this.exchangePath);
            this.exchangePath.setLength(originalLength);

            try (final var node = this.jsonDecoder.wrap(response)) {
                try (final var array = node.asArray()) {
                    if (!array.hasNextItem()) {
                        return null;
                    }

                    String exchangeName = null;

                    try (final var item = array.nextItem()) {
                        try (final var object = item.asObject()) {
                            while (object.hasNextKey()) {
                                try (final var key = object.nextKey()) {
                                    if (key.getName().equals("exchange_name")) {
                                        exchangeName = key.asString().toString();
                                    }
                                }
                            }
                        }
                    }
                    this.exchangeMap.put(exchangeId, new Exchange(exchangeId, exchangeName));
                }
            }
        }
        return this.exchangeMap.get(exchangeId);
    }

    public Listing getListing(final int listingId) {
        if (!this.listingMap.containsKey(listingId)) {
            final int originalLength = addParameters(this.listingPath, "listingId", listingId);
            final ByteBuffer response = this.registryConnection.get(this.listingPath);
            this.listingPath.setLength(originalLength);

            try (final var node = this.jsonDecoder.wrap(response)) {
                try (final var array = node.asArray()) {
                    if (!array.hasNextItem()) {
                        return null;
                    }

                    int exchangeId = -1;
                    int securityId = -1;
                    String exchangeSecurityId = null;
                    String exchangeSecuritySymbol = null;

                    try (final var item = array.nextItem()) {
                        try (final var object = item.asObject()) {
                            while (object.hasNextKey()) {
                                try (final var key = object.nextKey()) {
                                    if (key.getName().equals("exchange_id")) {
                                        exchangeId = key.asInt();
                                    } else if (key.getName().equals("security_id")) {
                                        securityId = key.asInt();
                                    } else if (key.getName().equals("exchange_security_id")) {
                                        exchangeSecurityId = key.asString().toString();
                                    } else if (key.getName().equals("exchange_security_symbol")) {
                                        exchangeSecuritySymbol = key.asString().toString();
                                    }
                                }
                            }
                        }
                    }
                    this.listingMap.put(listingId, new Listing(listingId, exchangeId, securityId, exchangeSecurityId, exchangeSecuritySymbol));
                }
            }
        }
        return this.listingMap.get(listingId);
    }

    private int addParameters(final MutableString string, final String paramName, final int value) {
        int originalLength = string.length();
        string.appendString(paramName);
        string.append((byte) '=');
        string.appendNaturalIntAscii(value);
        return originalLength;
    }
}
