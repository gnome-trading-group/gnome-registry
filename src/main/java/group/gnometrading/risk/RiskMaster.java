package group.gnometrading.risk;

import group.gnometrading.RegistryConnection;
import group.gnometrading.codecs.json.JsonDecoder;
import group.gnometrading.strings.ExpandingMutableString;
import java.nio.ByteBuffer;
import java.util.function.Consumer;

/**
 * Fetches and parses risk policies from the registry.
 * GC-free after construction: pre-allocated records are reused on every refresh.
 */
public final class RiskMaster {

    private static final String RISK_POLICIES_ENDPOINT = "/api/risk/policies";
    static final int MAX_POLICIES = 64;

    private final JsonDecoder jsonDecoder;
    private final RegistryConnection registryConnection;
    private final ExpandingMutableString riskPoliciesPath;

    private final RiskPolicyRecord[] records;

    // volatile write on refresh establishes happens-before for the array contents
    private volatile int policyCount = 0;

    public RiskMaster(final RegistryConnection registryConnection) {
        this.registryConnection = registryConnection;
        this.jsonDecoder = new JsonDecoder();
        this.riskPoliciesPath = new ExpandingMutableString(RISK_POLICIES_ENDPOINT);

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

    @SuppressWarnings("checkstyle:NestedTryDepth")
    public void refresh() {
        final ByteBuffer response = this.registryConnection.get(this.riskPoliciesPath);

        int count = 0;

        try (var node = this.jsonDecoder.wrap(response)) {
            try (var array = node.asArray()) {
                while (array.hasNextItem() && count < MAX_POLICIES) {
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
        record.enabled = true;
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
                        record.parametersJson.copy(key.asString());
                    } else if (key.getName().equals("enabled")) {
                        record.enabled = key.asBoolean();
                    }
                }
            }
        }
    }
}
