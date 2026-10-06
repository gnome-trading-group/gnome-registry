-- A strategy's positions are kept per (strategy, listing, mode) and inherited by its next session, so two sessions of
-- one strategy and mode must never trade the same listing at once: each OMS only sees its own fills. A session holds
-- a lease on each listing it trades from creation until its process is gone (STOPPED or FAILED, both only written
-- once the instance has terminated), and the ledger refuses writes from a session without one.
UPDATE strategy.session SET mode = lower(mode) WHERE mode <> lower(mode);
ALTER TABLE strategy.session ADD CONSTRAINT strategy_session_mode_check CHECK (mode IN ('paper', 'live'));

-- A short id for venue client order ids, which have tight length limits a UUID would mostly use up.
ALTER TABLE strategy.session ADD COLUMN session_seq BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE strategy.session ADD CONSTRAINT strategy_session_seq_key UNIQUE (session_seq);

CREATE TABLE strategy.session_listing (
    session_id  TEXT        NOT NULL,
    strategy_id INTEGER     NOT NULL,
    mode        VARCHAR(10) NOT NULL,
    listing_id  INTEGER     NOT NULL REFERENCES sm.listing (listing_id),
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    PRIMARY KEY (session_id, listing_id),
    FOREIGN KEY (session_id, strategy_id) REFERENCES strategy.session (session_id, strategy_id)
);

CREATE UNIQUE INDEX idx_session_listing_lease
    ON strategy.session_listing (strategy_id, mode, listing_id) WHERE active;

CREATE OR REPLACE FUNCTION strategy.release_session_leases() RETURNS trigger AS $$
BEGIN
    UPDATE strategy.session_listing SET active = FALSE WHERE session_id = NEW.session_id AND active;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_release_session_leases
    AFTER UPDATE OF status ON strategy.session
    FOR EACH ROW
    WHEN (NEW.status IN ('STOPPED', 'FAILED') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION strategy.release_session_leases();
