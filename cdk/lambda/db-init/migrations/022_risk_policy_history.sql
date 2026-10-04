-- Audit trail for risk.policy, most importantly who flipped a KILL_SWITCH and why. A trigger records every
-- change so nothing that writes the table (API, psql, a future service) can skip it. Writers attribute a
-- change by calling set_config('gnome.actor' / 'gnome.reason', ..., true) inside their transaction; changes
-- made without it are still recorded, with a null actor.
--
-- policy_id carries no foreign key so a policy's history outlives the policy itself.
CREATE TABLE IF NOT EXISTS risk.policy_history (
    history_id     bigserial PRIMARY KEY,
    policy_id      integer   NOT NULL,
    action         varchar   NOT NULL,
    old_enabled    boolean,
    new_enabled    boolean,
    old_parameters jsonb,
    new_parameters jsonb,
    actor          varchar,
    reason         varchar,
    changed_at     timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_policy_history_policy
    ON risk.policy_history (policy_id, changed_at DESC);

CREATE OR REPLACE FUNCTION risk.record_policy_history() RETURNS trigger AS $$
DECLARE
    -- missing_ok=true returns null when the setting was never defined in this session, and '' once it has
    -- been defined by an earlier transaction on the same pooled connection, so both must read as null.
    v_actor  varchar := NULLIF(current_setting('gnome.actor', true), '');
    v_reason varchar := NULLIF(current_setting('gnome.reason', true), '');
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO risk.policy_history (policy_id, action, new_enabled, new_parameters, actor, reason)
        VALUES (NEW.policy_id, TG_OP, NEW.enabled, NEW.parameters, v_actor, v_reason);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO risk.policy_history
            (policy_id, action, old_enabled, new_enabled, old_parameters, new_parameters, actor, reason)
        VALUES (NEW.policy_id, TG_OP, OLD.enabled, NEW.enabled, OLD.parameters, NEW.parameters, v_actor, v_reason);
        RETURN NEW;
    ELSE
        INSERT INTO risk.policy_history (policy_id, action, old_enabled, old_parameters, actor, reason)
        VALUES (OLD.policy_id, TG_OP, OLD.enabled, OLD.parameters, v_actor, v_reason);
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_risk_policy_history ON risk.policy;
CREATE TRIGGER trg_risk_policy_history
    AFTER INSERT OR UPDATE OR DELETE ON risk.policy
    FOR EACH ROW EXECUTE FUNCTION risk.record_policy_history();
