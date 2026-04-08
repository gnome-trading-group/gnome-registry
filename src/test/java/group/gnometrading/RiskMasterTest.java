package group.gnometrading;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import group.gnometrading.risk.RiskMaster;
import group.gnometrading.risk.RiskPolicyRecord;
import group.gnometrading.strings.ViewString;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class RiskMasterTest {

    @Mock
    private RegistryConnection registryConnection;

    private RiskMaster riskMaster;

    @BeforeEach
    void setUp() {
        riskMaster = new RiskMaster(registryConnection, 5000L);
    }

    private static final String KILL_SWITCH_ENABLED =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"scope\": 0, \"parameters\": \"{}\", \"enabled\": true}]";

    private static final String KILL_SWITCH_DISABLED =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"scope\": 0, \"parameters\": \"{}\", \"enabled\": false}]";

    private static final String MIXED_POLICIES =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"scope\": 0, \"parameters\": \"{}\", \"enabled\": true},"
                    + "{\"policy_id\": 2, \"policy_type\": \"MAX_POSITION\", \"scope\": 1, \"strategy_id\": 10, \"listing_id\": 0, \"parameters\": \"{}\", \"enabled\": true},"
                    + "{\"policy_id\": 3, \"policy_type\": \"MAX_POSITION\", \"scope\": 1, \"strategy_id\": 20, \"listing_id\": 0, \"parameters\": \"{}\", \"enabled\": true}]";

    @Test
    void testIsTradingEnabledWhenKillSwitchEnabled() {
        when(registryConnection.get(new ViewString("/api/risk/policies")))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_ENABLED.getBytes()));
        riskMaster.refresh();
        assertTrue(riskMaster.isTradingEnabled());
    }

    @Test
    void testIsTradingEnabledWhenKillSwitchDisabled() {
        when(registryConnection.get(new ViewString("/api/risk/policies")))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_DISABLED.getBytes()));
        riskMaster.refresh();
        assertFalse(riskMaster.isTradingEnabled());
    }

    @Test
    void testIsTradingEnabledWithNoPolicies() {
        when(registryConnection.get(new ViewString("/api/risk/policies"))).thenReturn(ByteBuffer.wrap("[]".getBytes()));
        riskMaster.refresh();
        assertTrue(riskMaster.isTradingEnabled());
    }

    @Test
    void testForEachPolicyForStrategy() {
        when(registryConnection.get(new ViewString("/api/risk/policies")))
                .thenReturn(ByteBuffer.wrap(MIXED_POLICIES.getBytes()));
        riskMaster.refresh();

        List<Integer> ids10 = new ArrayList<>();
        riskMaster.forEachPolicy(10, p -> ids10.add(p.policyId));
        assertEquals(2, ids10.size()); // KILL_SWITCH (global) + MAX_POSITION for strategy 10

        List<Integer> ids20 = new ArrayList<>();
        riskMaster.forEachPolicy(20, p -> ids20.add(p.policyId));
        assertEquals(2, ids20.size()); // KILL_SWITCH (global) + MAX_POSITION for strategy 20

        List<Integer> ids99 = new ArrayList<>();
        riskMaster.forEachPolicy(99, p -> ids99.add(p.policyId));
        assertEquals(1, ids99.size()); // only KILL_SWITCH (global)
        assertEquals(1, (int) ids99.get(0));
    }

    @Test
    void testPolicyTypeStoredAsGnomeString() {
        when(registryConnection.get(new ViewString("/api/risk/policies")))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_ENABLED.getBytes()));
        riskMaster.refresh();

        List<RiskPolicyRecord> seen = new ArrayList<>();
        riskMaster.forEachPolicy(0, seen::add);

        assertEquals(1, seen.size());
        assertTrue(seen.get(0).policyType.equals("KILL_SWITCH"));
    }

    @Test
    void testRefreshUpdatesInPlace() {
        when(registryConnection.get(new ViewString("/api/risk/policies")))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_ENABLED.getBytes()))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_DISABLED.getBytes()));

        riskMaster.refresh();
        assertTrue(riskMaster.isTradingEnabled());

        riskMaster.refresh();
        assertFalse(riskMaster.isTradingEnabled());

        verify(registryConnection, times(2)).get(any());
    }

    @Test
    void testMaybeRefreshOnlyRefreshesAfterInterval() {
        when(registryConnection.get(new ViewString("/api/risk/policies")))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_ENABLED.getBytes()));

        riskMaster.maybeRefresh(5001L); // 5001 - 0 >= 5000 → triggers refresh, sets lastRefreshMs=5001
        riskMaster.maybeRefresh(6000L); // 6000 - 5001 = 999 < 5000 → no refresh

        verify(registryConnection, times(1)).get(any());
    }
}
