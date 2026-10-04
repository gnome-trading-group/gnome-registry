package group.gnometrading.risk;

import group.gnometrading.RegistryConnection;
import group.gnometrading.codecs.json.JsonDecoder;
import group.gnometrading.codecs.json.JsonEncoder;
import group.gnometrading.strings.ExpandingMutableString;
import java.nio.ByteBuffer;
import java.util.function.Consumer;

/**
 * Fetches and parses risk policies from the registry.
 * GC-free after construction: pre-allocated records are reused on every refresh.
 */
public final class RiskMaster {

    private static final String RISK_POLICIES_ENDPOINT = "/api/risk/policies?enabled=true";
    private static final String RISK_HALTS_ENDPOINT = "/api/risk/halts";
    // {"strategyId":<int>,"reason":"..."}; reasons are short fixed strings.
    private static final int HALT_BODY_CAPACITY = 1024;
    static final int MAX_POLICIES = 64;

    private final JsonDecoder jsonDecoder;
    private final JsonEncoder jsonEncoder;
    private final ByteBuffer haltBody;
    private final RegistryConnection registryConnection;
    private final ExpandingMutableString riskPoliciesPath;
    private final ExpandingMutableString riskHaltsPath;

    private final RiskPolicyRecord[] records;

    // volatile write on refresh establishes happens-before for the array contents
    private volatile int policyCount = 0;

    public RiskMaster(final RegistryConnection registryConnection) {
        this.registryConnection = registryConnection;
        this.jsonDecoder = new JsonDecoder();
        this.jsonEncoder = new JsonEncoder();
        this.haltBody = ByteBuffer.allocate(HALT_BODY_CAPACITY);
        this.riskPoliciesPath = new ExpandingMutableString(RISK_POLICIES_ENDPOINT);
        this.riskHaltsPath = new ExpandingMutableString(RISK_HALTS_ENDPOINT);

        this.records = new RiskPolicyRecord[MAX_POLICIES];
        for (int i = 0; i < MAX_POLICIES; i++) {
            this.records[i] = new RiskPolicyRecord();
        }
    }

    public int getPolicyCount() {
        return this.policyCount;
    }

    public RiskPolicyRecord getRecord(final int index) {
        return this.records[index];
    }

    public void forEachPolicy(final int strategyId, final Consumer<RiskPolicyRecord> consumer) {
        final int count = this.policyCount;
        for (int i = 0; i < count; i++) {
            final RiskPolicyRecord record = this.records[i];
            if (record.scope == PolicyScope.GLOBAL || record.strategyId == strategyId) {
                consumer.accept(record);
            }
        }
    }

    /**
     * Asks the registry to enable this strategy's kill switch. The registry endpoint can only ever enable, so this
     * is safe to retry. Allocates; it is an emergency path, not part of the trading hot path.
     *
     * @throws RuntimeException if the registry does not accept the request
     */
    public void requestHalt(final int strategyId, final String reason) {
        this.haltBody.clear();
        this.jsonEncoder.wrap(this.haltBody);
        this.jsonEncoder
                .writeObjectStart()
                .writeObjectEntry("strategyId", strategyId)
                .writeComma()
                .writeObjectEntry("reason", reason == null ? "" : reason)
                .writeObjectEnd();
        this.registryConnection.post(this.riskHaltsPath, this.haltBody.array(), this.haltBody.position());
    }

    @SuppressWarnings("checkstyle:NestedTryDepth")
    public void refresh() {
        final ByteBuffer response = this.registryConnection.get(this.riskPoliciesPath);

        int count = 0;

        try (var node = this.jsonDecoder.wrap(response)) {
            try (var array = node.asArray()) {
                while (array.hasNextItem()) {
                    // A truncated policy set could silently drop a kill switch, so the caller must see a failure.
                    if (count == MAX_POLICIES) {
                        throw new IllegalStateException(
                                "Risk policy response exceeds MAX_POLICIES (" + MAX_POLICIES + ")");
                    }
                    final RiskPolicyRecord record = this.records[count];
                    resetRecord(record);
                    try (var item = array.nextItem()) {
                        parseRecord(item, record);
                    }
                    count++;
                }
            }
        }

        // volatile write flushes all record field writes above
        this.policyCount = count;
    }

    private static void resetRecord(final RiskPolicyRecord record) {
        record.policyId = -1;
        record.policyType.setLength(0);
        record.scope = null;
        record.strategyId = 0;
        record.listingId = 0;
        record.parametersJson.setLength(0);
        record.enabled = false;
    }

    @SuppressWarnings("checkstyle:NestedTryDepth")
    private static void parseRecord(final JsonDecoder.JsonNode item, final RiskPolicyRecord record) {
        try (var object = item.asObject()) {
            while (object.hasNextKey()) {
                try (var key = object.nextKey()) {
                    if (key.getName().equals("policy_id")) {
                        record.policyId = key.asInt();
                    } else if (key.getName().equals("policy_type")) {
                        record.policyType.copy(key.asString());
                    } else if (key.getName().equals("scope")) {
                        record.scope = PolicyScope.fromInt(key.asInt());
                    } else if (key.getName().equals("strategy_id")) {
                        record.strategyId = key.asInt();
                    } else if (key.getName().equals("listing_id")) {
                        record.listingId = key.asInt();
                    } else if (key.getName().equals("parameters")) {
                        record.parametersJson.copy(key.asRawJson());
                    } else if (key.getName().equals("enabled")) {
                        record.enabled = key.asBoolean();
                    }
                }
            }
        }
    }
}
