-- A kill switch can also target one venue account. Only the order gateway acts on it: it stops new orders on the
-- account and cancels what is working there, whichever strategies they belong to. The OMS never reads these rows, as
-- a row naming no strategy, session, exchange or listing would otherwise read to it as a global kill. So an account
-- row is a kill switch and names nothing else.
ALTER TABLE risk.policy
    ADD COLUMN account_id INTEGER REFERENCES account_master.venue_account (account_id),
    ADD CONSTRAINT risk_policy_account_is_kill CHECK (account_id IS NULL OR policy_type = 'KILL_SWITCH'),
    ADD CONSTRAINT risk_policy_account_alone CHECK (
        account_id IS NULL
        OR (session_id IS NULL AND strategy_id IS NULL AND exchange_id IS NULL AND listing_id IS NULL));

-- risk-halts.ts names these exact expressions in its ON CONFLICT, so the two change together.
DROP INDEX risk.idx_risk_policy_unique;
CREATE UNIQUE INDEX idx_risk_policy_unique
    ON risk.policy (policy_type, COALESCE(session_id, ''), COALESCE(strategy_id, 0), COALESCE(exchange_id, 0),
                    COALESCE(listing_id, 0), COALESCE(account_id, 0));

ALTER TABLE risk.policy_history
    ADD COLUMN old_account_id integer,
    ADD COLUMN new_account_id integer;

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
             new_listing_id, new_account_id, actor, reason)
        VALUES (NEW.policy_id, TG_OP, NEW.enabled, NEW.parameters, NEW.session_id, NEW.strategy_id,
                NEW.exchange_id, NEW.listing_id, NEW.account_id, v_actor, v_reason);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO risk.policy_history
            (policy_id, action, old_enabled, new_enabled, old_parameters, new_parameters,
             old_session_id, new_session_id, old_strategy_id, new_strategy_id, old_exchange_id, new_exchange_id,
             old_listing_id, new_listing_id, old_account_id, new_account_id, actor, reason)
        VALUES (NEW.policy_id, TG_OP, OLD.enabled, NEW.enabled, OLD.parameters, NEW.parameters,
                OLD.session_id, NEW.session_id, OLD.strategy_id, NEW.strategy_id, OLD.exchange_id, NEW.exchange_id,
                OLD.listing_id, NEW.listing_id, OLD.account_id, NEW.account_id, v_actor, v_reason);
        RETURN NEW;
    ELSE
        INSERT INTO risk.policy_history
            (policy_id, action, old_enabled, old_parameters, old_session_id, old_strategy_id, old_exchange_id,
             old_listing_id, old_account_id, actor, reason)
        VALUES (OLD.policy_id, TG_OP, OLD.enabled, OLD.parameters, OLD.session_id, OLD.strategy_id,
                OLD.exchange_id, OLD.listing_id, OLD.account_id, v_actor, v_reason);
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;
