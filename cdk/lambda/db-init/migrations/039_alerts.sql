-- Alerts: everything that should reach a person, from every source (the monitoring rules' tick, services and
-- sessions reporting an event, CloudWatch alarms), on one row per occurrence. A row is open while PENDING (a finding
-- that must persist before it pages) or FIRING, and at most one row per key is open, so repeats of the same problem
-- update it instead of notifying again. RESOLVED rows are the history; one with fire_count 0 is a resolve that
-- arrived before its alarm, kept so the late alarm isn't taken as new.
CREATE SCHEMA alert;

CREATE TABLE alert.alert (
    alert_id       BIGSERIAL   PRIMARY KEY,
    key            TEXT        NOT NULL,
    type           TEXT        NOT NULL,
    source         TEXT        NOT NULL CHECK (source IN ('tick', 'ingest', 'cloudwatch')),
    severity       TEXT        NOT NULL CHECK (severity IN ('CRITICAL', 'ERROR', 'WARNING', 'INFO')),
    status         TEXT        NOT NULL CHECK (status IN ('PENDING', 'FIRING', 'RESOLVED')),
    title          TEXT        NOT NULL,
    body           TEXT,
    actor          TEXT,
    labels         JSONB       NOT NULL DEFAULT '{}',
    links          JSONB       NOT NULL DEFAULT '[]',
    runbook_url    TEXT,
    strategy_id    INTEGER,
    session_id     TEXT,
    listing_id     INTEGER,
    exchange_id    INTEGER,
    account_id     INTEGER,
    mode           TEXT        CHECK (mode IN ('live', 'paper')),
    pending_ticks  INTEGER     NOT NULL DEFAULT 0,
    fire_count     INTEGER     NOT NULL DEFAULT 0,
    first_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- When the source says the state changed (an alarm's transition, a report's time), to drop events that arrive
    -- out of order.
    state_at       TIMESTAMPTZ NOT NULL,
    resolved_at    TIMESTAMPTZ,
    -- The sinks the latest notification (firing or resolved) still has to reach; the tick retries them.
    pending_sinks  TEXT[]      NOT NULL DEFAULT '{}',
    notified_at    TIMESTAMPTZ,
    slack_ts       TEXT
);

CREATE UNIQUE INDEX idx_alert_open_key ON alert.alert (key) WHERE status IN ('PENDING', 'FIRING');
CREATE INDEX idx_alert_key_recent ON alert.alert (key, alert_id DESC);
CREATE INDEX idx_alert_first_seen ON alert.alert (first_seen DESC);
CREATE INDEX idx_alert_session ON alert.alert (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_alert_undelivered ON alert.alert (notified_at) WHERE pending_sinks <> '{}';
