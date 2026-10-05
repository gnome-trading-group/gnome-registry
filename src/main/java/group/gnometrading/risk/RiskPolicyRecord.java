package group.gnometrading.risk;

import group.gnometrading.strings.ExpandingMutableString;

/**
 * A policy applies to exactly the ids it carries; an absent id is 0 (or an empty session id), never a real one.
 */
public final class RiskPolicyRecord {
    public int policyId;
    public final ExpandingMutableString policyType = new ExpandingMutableString();
    public final ExpandingMutableString sessionId = new ExpandingMutableString();
    public int strategyId;
    public int listingId;
    public final ExpandingMutableString parametersJson = new ExpandingMutableString();
    public boolean enabled;
}
