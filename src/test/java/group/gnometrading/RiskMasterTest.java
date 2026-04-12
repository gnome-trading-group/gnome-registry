package group.gnometrading;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import group.gnometrading.risk.PolicyScope;
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
        riskMaster = new RiskMaster(registryConnection);
    }

    private static final String KILL_SWITCH_ENABLED =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"scope\": 0, \"parameters\": \"{}\", \"enabled\": true}]";

    private static final String MIXED_POLICIES =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"scope\": 0, \"parameters\": \"{}\", \"enabled\": true},"
                    + "{\"policy_id\": 2, \"policy_type\": \"MAX_POSITION\", \"scope\": 1, \"strategy_id\": 10, \"listing_id\": 0, \"parameters\": \"{}\", \"enabled\": true},"
                    + "{\"policy_id\": 3, \"policy_type\": \"MAX_POSITION\", \"scope\": 1, \"strategy_id\": 20, \"listing_id\": 0, \"parameters\": \"{}\", \"enabled\": true}]";

    @Test
    void testGetPolicyCountAfterRefresh() {
        when(registryConnection.get(new ViewString("/api/risk/policies")))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_ENABLED.getBytes()));
        riskMaster.refresh();
        assertEquals(1, riskMaster.getPolicyCount());
    }

    @Test
    void testGetPolicyCountEmptyResponse() {
        when(registryConnection.get(new ViewString("/api/risk/policies"))).thenReturn(ByteBuffer.wrap("[]".getBytes()));
        riskMaster.refresh();
        assertEquals(0, riskMaster.getPolicyCount());
    }

    @Test
    void testGetRecordReturnsCorrectData() {
        when(registryConnection.get(new ViewString("/api/risk/policies")))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_ENABLED.getBytes()));
        riskMaster.refresh();

        RiskPolicyRecord record = riskMaster.getRecord(0);
        assertEquals(1, record.policyId);
        assertTrue(record.policyType.equals("KILL_SWITCH"));
        assertEquals(PolicyScope.GLOBAL, record.scope);
        assertTrue(record.enabled);
    }

    @Test
    void testGetPolicyCountAfterMultipleRefreshes() {
        when(registryConnection.get(new ViewString("/api/risk/policies")))
                .thenReturn(ByteBuffer.wrap(MIXED_POLICIES.getBytes()))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));

        riskMaster.refresh();
        assertEquals(3, riskMaster.getPolicyCount());

        riskMaster.refresh();
        assertEquals(0, riskMaster.getPolicyCount());
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
}
