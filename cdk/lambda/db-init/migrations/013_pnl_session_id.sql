ALTER TABLE pnl.snapshot
    ADD COLUMN session_id TEXT REFERENCES strategy.session(session_id);

CREATE INDEX idx_pnl_snapshot_session ON pnl.snapshot(session_id);
