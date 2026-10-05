package group.gnometrading;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import group.gnometrading.risk.RiskMaster;
import group.gnometrading.risk.RiskPolicyRecord;
import group.gnometrading.strings.ViewString;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
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
        riskMaster = new RiskMaster(registryConnection, 7, "abc");
    }

    private static final String POLICIES_PATH = "/api/risk/policies?enabled=true&forStrategy=7&forSession=abc";

    private static final String KILL_SWITCH_ENABLED =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"strategy_id\": null, \"listing_id\": null, \"parameters\": {}, \"enabled\": true}]";

    private static final String KILL_SWITCH_DISABLED =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"strategy_id\": null, \"listing_id\": null, \"parameters\": {}, \"enabled\": false}]";

    private static final String MIXED_POLICIES =
            "[{\"policy_id\": 1, \"policy_type\": \"KILL_SWITCH\", \"strategy_id\": null, \"listing_id\": null, \"parameters\": {}, \"enabled\": true},"
                    + "{\"policy_id\": 2, \"policy_type\": \"MAX_POSITION\", \"session_id\": null, \"strategy_id\": 10, \"listing_id\": null, \"parameters\": {}, \"enabled\": true},"
                    + "{\"policy_id\": 3, \"policy_type\": \"MAX_POSITION\", \"session_id\": \"abc\", \"strategy_id\": 20, \"listing_id\": 500, \"parameters\": {}, \"enabled\": true}]";

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
        assertEquals(0, record.strategyId);
        assertEquals(0, record.listingId);
        assertEquals(0, record.sessionId.length());
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
    void testRecordsCarryExactlyTheirTargetIds() {
        when(registryConnection.get(new ViewString(POLICIES_PATH)))
                .thenReturn(ByteBuffer.wrap(MIXED_POLICIES.getBytes()));
        riskMaster.refresh();

        RiskPolicyRecord strategyOnly = riskMaster.getRecord(1);
        assertEquals(10, strategyOnly.strategyId);
        assertEquals(0, strategyOnly.listingId);
        assertEquals(0, strategyOnly.sessionId.length());

        RiskPolicyRecord sessionOnListing = riskMaster.getRecord(2);
        assertTrue(sessionOnListing.sessionId.equals("abc"));
        assertEquals(20, sessionOnListing.strategyId);
        assertEquals(500, sessionOnListing.listingId);
    }

    @Test
    void testASessionIdFromAPreviousRefreshDoesNotLinger() {
        when(registryConnection.get(new ViewString(POLICIES_PATH)))
                .thenReturn(ByteBuffer.wrap(MIXED_POLICIES.getBytes()))
                .thenReturn(ByteBuffer.wrap(MIXED_POLICIES
                        .replace("\"session_id\": \"abc\"", "\"session_id\": null")
                        .getBytes()));
        riskMaster.refresh();
        riskMaster.refresh();
        assertEquals(0, riskMaster.getRecord(2).sessionId.length());
    }

    @Test
    void testWithoutASessionOnlySessionlessPoliciesAreFetched() {
        RiskMaster sessionless = new RiskMaster(registryConnection, 7, null);
        when(registryConnection.get(any())).thenReturn(ByteBuffer.wrap("[]".getBytes()));
        sessionless.refresh();
        verify(registryConnection).get(new ViewString("/api/risk/policies?enabled=true&forStrategy=7&forSession=none"));
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
        assertEquals(0, record.strategyId);
        assertEquals(0, record.listingId);
        assertEquals(0, record.sessionId.length());
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
                    .append(", \"policy_type\": \"KILL_SWITCH\", \"parameters\": {}, \"enabled\": true}");
        }
        return json.append(']').toString();
    }

    @Test
    void testRefreshPollsOnlyEnabledPolicies() {
        when(registryConnection.get(any())).thenReturn(ByteBuffer.wrap("[]".getBytes()));
        riskMaster.refresh();
        verify(registryConnection).get(new ViewString(POLICIES_PATH));
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
