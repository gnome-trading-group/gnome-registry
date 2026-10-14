-- A risk policy can also target an exchange: on its own it covers every strategy there (a venue-wide kill switch),
-- with a strategy it covers that strategy's listings there (its budget on that venue). A listing already implies its
-- exchange, so a row names one or the other.
ALTER TABLE risk.policy
    ADD COLUMN exchange_id INTEGER REFERENCES sm.exchange (exchange_id),
    ADD CONSTRAINT risk_policy_exchange_positive CHECK (exchange_id > 0),
    ADD CONSTRAINT risk_policy_exchange_or_listing CHECK (exchange_id IS NULL OR listing_id IS NULL);

-- risk-halts.ts names these exact expressions in its ON CONFLICT, so the two change together.
DROP INDEX risk.idx_risk_policy_unique;
CREATE UNIQUE INDEX idx_risk_policy_unique
    ON risk.policy (policy_type, COALESCE(session_id, ''), COALESCE(strategy_id, 0), COALESCE(exchange_id, 0),
                    COALESCE(listing_id, 0));

ALTER TABLE risk.policy_history
    ADD COLUMN old_exchange_id integer,
    ADD COLUMN new_exchange_id integer;

CREATE OR REPLACE FUNCTION risk.record_policy_history() RETURNS trigger AS $$
DECLARE
    -- missing_ok=true returns null when the setting was never defined in this session, and '' once it has
    -- been defined by an earlier transaction on the same pooled connection, so both must read as null.
    v_actor  varchar := NULLIF(current_setting('gnome.actor', true), '');
    v_reason varchar := NULLIF(current_setting('gnome.reason', true), '');
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO risk.policy_history
            (policy_id, action, new_enabled, new_parameters, new_session_id, new_strategy_id, new_exchange_id,
             new_listing_id, actor, reason)
        VALUES (NEW.policy_id, TG_OP, NEW.enabled, NEW.parameters, NEW.session_id, NEW.strategy_id,
                NEW.exchange_id, NEW.listing_id, v_actor, v_reason);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO risk.policy_history
            (policy_id, action, old_enabled, new_enabled, old_parameters, new_parameters,
             old_session_id, new_session_id, old_strategy_id, new_strategy_id, old_exchange_id, new_exchange_id,
             old_listing_id, new_listing_id, actor, reason)
        VALUES (NEW.policy_id, TG_OP, OLD.enabled, NEW.enabled, OLD.parameters, NEW.parameters,
                OLD.session_id, NEW.session_id, OLD.strategy_id, NEW.strategy_id, OLD.exchange_id, NEW.exchange_id,
                OLD.listing_id, NEW.listing_id, v_actor, v_reason);
        RETURN NEW;
    ELSE
        INSERT INTO risk.policy_history
            (policy_id, action, old_enabled, old_parameters, old_session_id, old_strategy_id, old_exchange_id,
             old_listing_id, actor, reason)
        VALUES (OLD.policy_id, TG_OP, OLD.enabled, OLD.parameters, OLD.session_id, OLD.strategy_id,
                OLD.exchange_id, OLD.listing_id, v_actor, v_reason);
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- MAX_NOTIONAL only ever capped one order; its new name says so, next to MAX_COMMITTED_CAPITAL, which caps the
-- dollars a strategy has tied up.
UPDATE risk.policy
SET policy_type = 'MAX_ORDER_NOTIONAL',
    parameters = jsonb_build_object('maxOrderNotional', parameters->'maxNotionalValue')
WHERE policy_type = 'MAX_NOTIONAL';

-- When a pending modify was confirmed, so the order's price and size are the venue's current ones.
ALTER TABLE ledger.order ADD COLUMN modified_at TIMESTAMPTZ;
