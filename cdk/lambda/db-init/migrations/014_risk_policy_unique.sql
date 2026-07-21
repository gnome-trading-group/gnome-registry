DELETE FROM risk.policy a
    USING risk.policy b
    WHERE a.policy_id > b.policy_id
      AND a.policy_type = b.policy_type
      AND a.scope = b.scope
      AND COALESCE(a.strategy_id, 0) = COALESCE(b.strategy_id, 0)
      AND COALESCE(a.listing_id, 0) = COALESCE(b.listing_id, 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_policy_unique
    ON risk.policy (policy_type, scope, COALESCE(strategy_id, 0), COALESCE(listing_id, 0));
