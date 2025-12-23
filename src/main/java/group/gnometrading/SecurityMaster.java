package group.gnometrading;

import group.gnometrading.codecs.json.JSONDecoder;
import group.gnometrading.schemas.SchemaType;
import group.gnometrading.sm.Exchange;
import group.gnometrading.sm.Listing;
import group.gnometrading.sm.Security;
import group.gnometrading.strings.ExpandingMutableString;
import group.gnometrading.strings.MutableString;

import java.nio.ByteBuffer;

/**
 * SecurityMaster is an abstraction for the database security master layer.
 * These class will produce garbage when fetching from the API.
 */
public class SecurityMaster {

    private static final String SECURITY_ENDPOINT = "/api/securities?";
    private static final String EXCHANGE_ENDPOINT = "/api/exchanges?";
    private static final String LISTING_ENDPOINT = "/api/listings?";

    private final JSONDecoder jsonDecoder;
    private final RegistryConnection registryConnection;

    private final MutableString securityPath;
    private final MutableString exchangePath;
    private final MutableString listingPath;

    public SecurityMaster(final RegistryConnection registryConnection) {
        this.registryConnection = registryConnection;
        this.jsonDecoder = new JSONDecoder();

        this.securityPath = new ExpandingMutableString(SECURITY_ENDPOINT);
        this.exchangePath = new ExpandingMutableString(EXCHANGE_ENDPOINT);
        this.listingPath = new ExpandingMutableString(LISTING_ENDPOINT);
    }

    public Security getSecurity(final int securityId) {
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
                return new Security(securityId, symbol, type);
            }
        }
    }

    public Exchange getExchange(final int exchangeId) {
        final int originalLength = addParameters(this.exchangePath, "exchangeId", exchangeId);
        final ByteBuffer response = this.registryConnection.get(this.exchangePath);
        this.exchangePath.setLength(originalLength);

        try (final var node = this.jsonDecoder.wrap(response)) {
            try (final var array = node.asArray()) {
                if (!array.hasNextItem()) {
                    return null;
                }

                String exchangeName = null;
                String region = null;
                SchemaType schemaType = null;

                try (final var item = array.nextItem()) {
                    try (final var object = item.asObject()) {
                        while (object.hasNextKey()) {
                            try (final var key = object.nextKey()) {
                                if (key.getName().equals("exchange_name")) {
                                    exchangeName = key.asString().toString();
                                } else if (key.getName().equals("region")) {
                                    region = key.asString().toString();
                                } else if (key.getName().equals("schema_type")) {
                                    schemaType = SchemaType.findById(key.asString().toString());
                                }
                            }
                        }
                    }
                }
                return new Exchange(exchangeId, exchangeName, region, schemaType);
            }
        }
    }

    public Listing getListing(final int exchangeId, final int securityId) {
        final int originalLength = addParameters(this.listingPath, "exchangeId", exchangeId, "securityId", securityId);
        final ByteBuffer response = this.registryConnection.get(this.listingPath);
        this.listingPath.setLength(originalLength);
        return parseListing(response);
    }

    public Listing getListing(final int listingId) {
        final int originalLength = addParameters(this.listingPath, "listingId", listingId);
        final ByteBuffer response = this.registryConnection.get(this.listingPath);
        this.listingPath.setLength(originalLength);
        return parseListing(response);
    }

    private Listing parseListing(final ByteBuffer response) {
        try (final var node = this.jsonDecoder.wrap(response)) {
            try (final var array = node.asArray()) {
                if (!array.hasNextItem()) {
                    return null;
                }

                int listingId = -1;
                int exchangeId = -1;
                int securityId = -1;
                String exchangeSecurityId = null;
                String exchangeSecuritySymbol = null;

                try (final var item = array.nextItem()) {
                    try (final var object = item.asObject()) {
                        while (object.hasNextKey()) {
                            try (final var key = object.nextKey()) {
                                if (key.getName().equals("listing_id")) {
                                    listingId = key.asInt();
                                } else if (key.getName().equals("exchange_id")) {
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
                final Exchange exchange = getExchange(exchangeId);
                final Security security = getSecurity(securityId);
                return new Listing(listingId, exchange, security, exchangeSecurityId, exchangeSecuritySymbol);
            }
        }
    }

    private int addParameters(final MutableString string, final String paramName, final int value) {
        int originalLength = string.length();
        string.appendString(paramName);
        string.append((byte) '=');
        string.appendNaturalIntAscii(value);
        return originalLength;
    }

    private int addParameters(final MutableString string, final String paramName1, final int value1, final String paramName2, final int value2) {
        int originalLength = addParameters(string, paramName1, value1);
        string.append((byte) '&');
        addParameters(string, paramName2, value2);
        return originalLength;
    }
}
