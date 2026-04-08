package group.gnometrading.risk;

import group.gnometrading.strings.ExpandingMutableString;

public final class RiskPolicyRecord {
    public int policyId;
    public final ExpandingMutableString policyType = new ExpandingMutableString();
    public int scope;
    public int strategyId;
    public int listingId;
    public final ExpandingMutableString parametersJson = new ExpandingMutableString();
    public boolean enabled;
}
