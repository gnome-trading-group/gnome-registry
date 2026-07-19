CREATE TABLE strategy.session (
    session_id TEXT PRIMARY KEY,
    strategy_id INTEGER NOT NULL REFERENCES strategy.strategy(strategy_id),
    status VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED',
    mode VARCHAR(10) NOT NULL,
    config JSONB NOT NULL,
    research_commit VARCHAR(40),
    task_arn TEXT,
    task_definition_arn TEXT,
    failure_reason TEXT,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    stopped_at TIMESTAMPTZ,
    date_created TIMESTAMPTZ DEFAULT NOW(),
    date_modified TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_session_status ON strategy.session(status, started_at DESC);
CREATE INDEX idx_session_strategy ON strategy.session(strategy_id);
