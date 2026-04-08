package group.gnometrading.risk;

import group.gnometrading.RegistryConnection;
import group.gnometrading.codecs.json.JsonDecoder;
import group.gnometrading.strings.ExpandingMutableString;
import java.nio.ByteBuffer;
import java.util.function.Consumer;

/**
 * RiskMaster periodically refreshes risk policies from the registry.
 * GC-free after construction: pre-allocated records are reused on every refresh.
 * isTradingEnabled() is a single volatile read.
 */
public final class RiskMaster {

    private static final String RISK_POLICIES_ENDPOINT = "/api/risk/policies";
    private static final String KILL_SWITCH_TYPE = "KILL_SWITCH";
    private static final int SCOPE_GLOBAL = 0;
    private static final int MAX_POLICIES = 64;

    private final JsonDecoder jsonDecoder;
    private final RegistryConnection registryConnection;
    private final ExpandingMutableString riskPoliciesPath;
    private final long refreshIntervalMs;

    private final RiskPolicyRecord[] records;

    // volatile writes on refresh establish happens-before for the array contents
    private volatile boolean tradingEnabled = true;
    private volatile int policyCount = 0;

    private long lastRefreshMs;

    public RiskMaster(final RegistryConnection registryConnection, final long refreshIntervalMs) {
        this.registryConnection = registryConnection;
        this.jsonDecoder = new JsonDecoder();
        this.riskPoliciesPath = new ExpandingMutableString(RISK_POLICIES_ENDPOINT);
        this.refreshIntervalMs = refreshIntervalMs;
        this.lastRefreshMs = 0;

        this.records = new RiskPolicyRecord[MAX_POLICIES];
        for (int i = 0; i < MAX_POLICIES; i++) {
            this.records[i] = new RiskPolicyRecord();
        }
    }

    public boolean isTradingEnabled() {
        return this.tradingEnabled;
    }

    public void forEachPolicy(final int strategyId, final Consumer<RiskPolicyRecord> consumer) {
        final int count = this.policyCount;
        for (int i = 0; i < count; i++) {
            final RiskPolicyRecord record = this.records[i];
            if (record.scope == SCOPE_GLOBAL || record.strategyId == strategyId) {
                consumer.accept(record);
            }
        }
    }

    @SuppressWarnings("checkstyle:NestedTryDepth")
    public void refresh() {
        final ByteBuffer response = this.registryConnection.get(this.riskPoliciesPath);

        int count = 0;
        boolean killSwitchEnabled = true;

        try (var node = this.jsonDecoder.wrap(response)) {
            try (var array = node.asArray()) {
                while (array.hasNextItem() && count < MAX_POLICIES) {
                    final RiskPolicyRecord record = this.records[count];
                    resetRecord(record);
                    try (var item = array.nextItem()) {
                        parseRecord(item, record);
                    }
                    if (record.scope == SCOPE_GLOBAL && record.policyType.equals(KILL_SWITCH_TYPE)) {
                        killSwitchEnabled = record.enabled;
                    }
                    count++;
                }
            }
        }

        // volatile writes flush all record field writes above — readers who read
        // policyCount/tradingEnabled after this will see a consistent snapshot
        this.tradingEnabled = killSwitchEnabled;
        this.policyCount = count;
    }

    private static void resetRecord(final RiskPolicyRecord record) {
        record.policyId = -1;
        record.policyType.setLength(0);
        record.scope = -1;
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
                        record.scope = key.asInt();
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

    public void maybeRefresh(final long nowEpochMs) {
        if (nowEpochMs - this.lastRefreshMs >= this.refreshIntervalMs) {
            refresh();
            this.lastRefreshMs = nowEpochMs;
        }
    }
}
