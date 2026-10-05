-- A risk policy applies to exactly the ids it carries: none is global, a strategy covers every session of it, a
-- listing covers every strategy on it, both cover that strategy on that listing, and a session narrows a strategy
-- row to one running instance. scope used to choose which of the ids counted and silently ignored the rest, so it
-- goes. 0 is never a real id, so absent ids are NULL and can't be confused with one.
DROP INDEX IF EXISTS risk.idx_risk_policy_unique;
DROP INDEX IF EXISTS risk.idx_risk_policy_scope;

ALTER TABLE risk.policy DROP COLUMN scope;

-- The composite key lets a session row name its strategy only as the one the session actually runs.
ALTER TABLE strategy.session ADD CONSTRAINT strategy_session_session_strategy_key UNIQUE (session_id, strategy_id);

ALTER TABLE risk.policy
    ADD COLUMN session_id TEXT,
    ADD CONSTRAINT risk_policy_session_fkey
        FOREIGN KEY (session_id, strategy_id) REFERENCES strategy.session (session_id, strategy_id),
    ADD CONSTRAINT risk_policy_session_has_strategy CHECK (session_id IS NULL OR strategy_id IS NOT NULL),
    ADD CONSTRAINT risk_policy_strategy_positive CHECK (strategy_id > 0),
    ADD CONSTRAINT risk_policy_listing_positive CHECK (listing_id > 0);

CREATE UNIQUE INDEX idx_risk_policy_unique
    ON risk.policy (policy_type, COALESCE(session_id, ''), COALESCE(strategy_id, 0), COALESCE(listing_id, 0));

ALTER TABLE risk.policy_history
    ADD COLUMN old_session_id  TEXT,
    ADD COLUMN new_session_id  TEXT,
    ADD COLUMN old_strategy_id integer,
    ADD COLUMN new_strategy_id integer,
    ADD COLUMN old_listing_id  integer,
    ADD COLUMN new_listing_id  integer;

CREATE OR REPLACE FUNCTION risk.record_policy_history() RETURNS trigger AS $$
DECLARE
    -- missing_ok=true returns null when the setting was never defined in this session, and '' once it has
    -- been defined by an earlier transaction on the same pooled connection, so both must read as null.
    v_actor  varchar := NULLIF(current_setting('gnome.actor', true), '');
    v_reason varchar := NULLIF(current_setting('gnome.reason', true), '');
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO risk.policy_history
            (policy_id, action, new_enabled, new_parameters, new_session_id, new_strategy_id, new_listing_id,
             actor, reason)
        VALUES (NEW.policy_id, TG_OP, NEW.enabled, NEW.parameters, NEW.session_id, NEW.strategy_id,
                NEW.listing_id, v_actor, v_reason);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO risk.policy_history
            (policy_id, action, old_enabled, new_enabled, old_parameters, new_parameters,
             old_session_id, new_session_id, old_strategy_id, new_strategy_id, old_listing_id, new_listing_id,
             actor, reason)
        VALUES (NEW.policy_id, TG_OP, OLD.enabled, NEW.enabled, OLD.parameters, NEW.parameters,
                OLD.session_id, NEW.session_id, OLD.strategy_id, NEW.strategy_id, OLD.listing_id, NEW.listing_id,
                v_actor, v_reason);
        RETURN NEW;
    ELSE
        INSERT INTO risk.policy_history
            (policy_id, action, old_enabled, old_parameters, old_session_id, old_strategy_id, old_listing_id,
             actor, reason)
        VALUES (OLD.policy_id, TG_OP, OLD.enabled, OLD.parameters, OLD.session_id, OLD.strategy_id,
                OLD.listing_id, v_actor, v_reason);
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;
