package group.gnometrading;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import group.gnometrading.risk.PolicyScope;
import group.gnometrading.risk.RiskMaster;
import group.gnometrading.risk.RiskPolicyRecord;
import group.gnometrading.strings.ViewString;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
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

    private static final String POLICIES_PATH = "/api/risk/policies?enabled=true";

    private static final String KILL_SWITCH_ENABLED =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"scope\": 0, \"strategy_id\": null, \"listing_id\": null, \"parameters\": {}, \"enabled\": true}]";

    private static final String KILL_SWITCH_DISABLED =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"scope\": 0, \"strategy_id\": null, \"listing_id\": null, \"parameters\": {}, \"enabled\": false}]";

    private static final String MIXED_POLICIES =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"scope\": 0, \"strategy_id\": null, \"listing_id\": null, \"parameters\": {}, \"enabled\": true},"
                    + "{\"policy_id\": 2, \"policy_type\": \"MAX_POSITION\", \"scope\": 1, \"strategy_id\": 10, \"listing_id\": 0, \"parameters\": {}, \"enabled\": true},"
                    + "{\"policy_id\": 3, \"policy_type\": \"MAX_POSITION\", \"scope\": 1, \"strategy_id\": 20, \"listing_id\": 0, \"parameters\": {}, \"enabled\": true}]";

    @Test
    void testGetPolicyCountAfterRefresh() {
        when(registryConnection.get(new ViewString(POLICIES_PATH)))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_ENABLED.getBytes()));
        riskMaster.refresh();
        assertEquals(1, riskMaster.getPolicyCount());
    }

    @Test
    void testGetPolicyCountEmptyResponse() {
        when(registryConnection.get(new ViewString(POLICIES_PATH))).thenReturn(ByteBuffer.wrap("[]".getBytes()));
        riskMaster.refresh();
        assertEquals(0, riskMaster.getPolicyCount());
    }

    @Test
    void testGetRecordReturnsCorrectData() {
        when(registryConnection.get(new ViewString(POLICIES_PATH)))
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
        when(registryConnection.get(new ViewString(POLICIES_PATH)))
                .thenReturn(ByteBuffer.wrap(MIXED_POLICIES.getBytes()))
                .thenReturn(ByteBuffer.wrap("[]".getBytes()));

        riskMaster.refresh();
        assertEquals(3, riskMaster.getPolicyCount());

        riskMaster.refresh();
        assertEquals(0, riskMaster.getPolicyCount());
    }

    @Test
    void testForEachPolicyForStrategy() {
        when(registryConnection.get(new ViewString(POLICIES_PATH)))
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
    void testDisabledPolicyWithRawObjectParameters() {
        when(registryConnection.get(new ViewString(POLICIES_PATH)))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_DISABLED.getBytes()));
        riskMaster.refresh();

        assertEquals(1, riskMaster.getPolicyCount());
        RiskPolicyRecord record = riskMaster.getRecord(0);
        assertEquals(1, record.policyId);
        assertTrue(record.policyType.equals("KILL_SWITCH"));
        assertEquals(PolicyScope.GLOBAL, record.scope);
        assertFalse(record.enabled);
        assertTrue(record.parametersJson.equals("{}"));
    }

    private static String policiesJson(int count) {
        StringBuilder json = new StringBuilder("[");
        for (int i = 0; i < count; i++) {
            if (i > 0) {
                json.append(',');
            }
            json.append("{\"policy_id\": ")
                    .append(i + 1)
                    .append(", \"policy_type\": \"KILL_SWITCH\", \"scope\": 0, \"parameters\": {}, \"enabled\": true}");
        }
        return json.append(']').toString();
    }

    @Test
    void testRefreshPollsOnlyEnabledPolicies() {
        when(registryConnection.get(any())).thenReturn(ByteBuffer.wrap("[]".getBytes()));
        riskMaster.refresh();
        verify(registryConnection).get(new ViewString("/api/risk/policies?enabled=true"));
    }

    @Test
    void testRefreshAcceptsExactlyMaxPolicies() {
        when(registryConnection.get(new ViewString(POLICIES_PATH)))
                .thenReturn(ByteBuffer.wrap(policiesJson(64).getBytes()));
        riskMaster.refresh();
        assertEquals(64, riskMaster.getPolicyCount());
    }

    @Test
    void testRefreshThrowsWhenResponseExceedsMaxPolicies() {
        when(registryConnection.get(new ViewString(POLICIES_PATH)))
                .thenReturn(ByteBuffer.wrap(KILL_SWITCH_ENABLED.getBytes()))
                .thenReturn(ByteBuffer.wrap(policiesJson(65).getBytes()));
        riskMaster.refresh();

        IllegalStateException e = assertThrows(IllegalStateException.class, riskMaster::refresh);
        assertTrue(e.getMessage().contains("64"));
        assertEquals(1, riskMaster.getPolicyCount());
    }

    private String capturePostedHalt() {
        ArgumentCaptor<byte[]> body = ArgumentCaptor.forClass(byte[].class);
        ArgumentCaptor<Integer> length = ArgumentCaptor.forClass(Integer.class);
        verify(registryConnection, atLeastOnce())
                .post(eq(new ViewString("/api/risk/halts")), body.capture(), length.capture());
        return new String(body.getValue(), 0, length.getValue(), StandardCharsets.UTF_8);
    }

    @Test
    void testRequestHaltPostsStrategyAndReason() {
        riskMaster.requestHalt(7, "max loss breached");
        assertEquals("{\"strategyId\":7,\"reason\":\"max loss breached\"}", capturePostedHalt());
    }

    @Test
    void testRequestHaltEscapesQuotesAndBackslashes() {
        riskMaster.requestHalt(3, "bad \"fill\" at C:\\venue");
        assertEquals("{\"strategyId\":3,\"reason\":\"bad \\\"fill\\\" at C:\\\\venue\"}", capturePostedHalt());
    }

    @Test
    void testRepeatedHaltsEachPostOnlyTheirOwnBody() {
        riskMaster.requestHalt(12345, "a much longer first reason");
        riskMaster.requestHalt(7, "short");
        assertEquals("{\"strategyId\":7,\"reason\":\"short\"}", capturePostedHalt());
    }

    @Test
    void testRequestHaltWithNullReasonSendsEmptyReason() {
        riskMaster.requestHalt(3, null);
        assertEquals("{\"strategyId\":3,\"reason\":\"\"}", capturePostedHalt());
    }

    @Test
    void testRequestHaltPropagatesRegistryFailure() {
        doThrow(new RuntimeException("Unable to post to the registry. Status code: 500"))
                .when(registryConnection)
                .post(any(), any(), anyInt());
        assertThrows(RuntimeException.class, () -> riskMaster.requestHalt(7, "x"));
    }
}
