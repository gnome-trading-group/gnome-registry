-- The market-data accounts a source's shards collect with: dedicated, unfunded accounts, one or more per source whose
-- feed needs a key (Kalshi, Polymarket US), so collection never spends a trading account's connections. This is what
-- exists; how many connections each holds right now is the control plane's, not stored here. The key itself is in
-- Secrets Manager under secret_name, gnome/market-data/<source>/<label>, written by the account-creation Lambda.
CREATE TABLE md.source_account (
    account_id        SERIAL      PRIMARY KEY,
    source_id         INTEGER     NOT NULL REFERENCES md.source (source_id) ON DELETE CASCADE,
    label             VARCHAR(32) NOT NULL CHECK (label ~ '^[a-z0-9][a-z0-9-]*$'),
    secret_name       VARCHAR     NOT NULL,
    -- The connections this account may hold; NULL takes the source's connections_per_scope.
    connection_budget INTEGER     CHECK (connection_budget > 0),
    status            VARCHAR(7)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
    note              VARCHAR,
    created_by        VARCHAR     NOT NULL,
    date_created      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    date_modified     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, label)
);
