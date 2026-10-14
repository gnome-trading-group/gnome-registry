-- What each venue account actually holds, as the venue reports it, and whether that agrees with the ledger. The
-- ledger knows fills; the venue knows cash. Deposits, withdrawals and the venue's own credits are recorded here so
-- the two can be reconciled, and a launch can be refused when the money behind the allocations isn't there.
CREATE SCHEMA treasury;

-- Per-account settings, all money in price units (1e9 per dollar).
--   min_buffer             kept free: live allocations on the account may not exceed its equity less this
--   low_balance_threshold  available cash below this is flagged
--   cash_tolerance         a cash difference up to this is fee rounding, not a break
--   settlement_grace       how long a settled market may stay unpaid by the venue before it counts as a break
--   recon_since            reconciliation starts here; an OPENING transfer stands in for everything before it
--   partition_low_thresholds  per venue partition (Kalshi's exchange shards, whose cash only backs orders on their own
--                          markets), the cash below which it is flagged: {"3": 50000000000}; partitions not named
--                          are never flagged, since which ones the account trades isn't recorded
CREATE TABLE treasury.account_config (
    account_id            INTEGER     PRIMARY KEY REFERENCES account_master.venue_account (account_id),
    min_buffer            BIGINT      NOT NULL DEFAULT 0 CHECK (min_buffer >= 0),
    low_balance_threshold BIGINT      NOT NULL DEFAULT 0 CHECK (low_balance_threshold >= 0),
    cash_tolerance        BIGINT      NOT NULL DEFAULT 50000000 CHECK (cash_tolerance >= 0),
    snapshot_max_age      INTERVAL    NOT NULL DEFAULT INTERVAL '15 minutes',
    settlement_grace      INTERVAL    NOT NULL DEFAULT INTERVAL '2 hours',
    max_active_days       INTEGER     CHECK (max_active_days > 0),
    dust_threshold        BIGINT      NOT NULL DEFAULT 10000000 CHECK (dust_threshold >= 0),
    recon_since           TIMESTAMPTZ,
    recon_enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
    partition_low_thresholds JSONB    NOT NULL DEFAULT '{}',
    actor                 TEXT,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One reading of an account's balances. An ERROR row records a poll that failed, so a silent poller and a failing
-- one can be told apart. MANUAL rows are an operator's reading when the poller can't run.
--   cash_total        all the account's cash, including what resting orders hold
--   cash_available    what new orders may still use
--   portfolio_value   the venue's own valuation of the positions (marked to market)
--   redeemable_value  resolved positions not yet redeemed for cash (Polymarket), worth their payout
--   cash_by_partition cash per venue partition, where the venue splits it (Kalshi's exchange shards): {"0": "..."}
CREATE TABLE treasury.balance_snapshot (
    snapshot_id      BIGSERIAL   PRIMARY KEY,
    account_id       INTEGER     NOT NULL REFERENCES account_master.venue_account (account_id),
    taken_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source           VARCHAR(8)  NOT NULL CHECK (source IN ('POLLER', 'MANUAL')),
    status           VARCHAR(8)  NOT NULL CHECK (status IN ('OK', 'ERROR')),
    error            TEXT,
    cash_total       BIGINT,
    cash_available   BIGINT,
    portfolio_value  BIGINT,
    redeemable_value BIGINT,
    cash_by_partition JSONB,
    raw              JSONB,
    actor            TEXT,
    CHECK (status = 'ERROR' OR cash_total IS NOT NULL)
);

CREATE INDEX idx_balance_snapshot_account ON treasury.balance_snapshot (account_id, taken_at DESC);

-- Each position the venue reported in a snapshot, keyed as the venue knows it (a Kalshi market ticker, a Polymarket
-- token id, a Polymarket US market slug). Quantities are in size units, signed as the venue signs them.
CREATE TABLE treasury.venue_position (
    snapshot_id BIGINT  NOT NULL REFERENCES treasury.balance_snapshot (snapshot_id) ON DELETE CASCADE,
    venue_key   TEXT    NOT NULL,
    quantity    BIGINT  NOT NULL,
    redeemable  BOOLEAN NOT NULL DEFAULT FALSE,
    value       BIGINT,
    PRIMARY KEY (snapshot_id, venue_key)
);

-- Money moving into or out of an account other than by trading, appended and never edited: a mistake is corrected
-- by another row. OPENING is the account's cash when reconciliation starts. Amounts are signed: in is positive.
CREATE TABLE treasury.transfer (
    transfer_id  BIGSERIAL   PRIMARY KEY,
    account_id   INTEGER     NOT NULL REFERENCES account_master.venue_account (account_id),
    kind         VARCHAR(16) NOT NULL
                 CHECK (kind IN ('OPENING', 'DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'REWARD', 'FEE_ADJUSTMENT', 'CORRECTION')),
    amount       BIGINT      NOT NULL,
    occurred_at  TIMESTAMPTZ NOT NULL,
    external_ref TEXT,
    reason       TEXT,
    actor        TEXT        NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (CASE kind
               WHEN 'WITHDRAWAL' THEN amount < 0
               WHEN 'FEE_ADJUSTMENT' THEN TRUE
               WHEN 'CORRECTION' THEN TRUE
               ELSE amount >= 0
           END)
);

CREATE INDEX idx_transfer_account ON treasury.transfer (account_id, occurred_at);

-- Each reconciliation of an account's cash against what the ledger and transfers say it should hold.
--   PENDING  out of tolerance once; a break needs it twice, minutes apart, with nothing booked in between to explain it
--   ERROR    the snapshot itself failed
CREATE TABLE treasury.recon_run (
    run_id             BIGSERIAL   PRIMARY KEY,
    account_id         INTEGER     NOT NULL REFERENCES account_master.venue_account (account_id),
    snapshot_id        BIGINT      NOT NULL REFERENCES treasury.balance_snapshot (snapshot_id) ON DELETE CASCADE,
    ran_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expected_cash      BIGINT,
    venue_cash         BIGINT,
    cash_diff          BIGINT,
    cash_status        VARCHAR(8)  NOT NULL CHECK (cash_status IN ('OK', 'PENDING', 'BREAK', 'ERROR', 'OFF')),
    ledger_fingerprint TEXT,
    positions_checked  INTEGER     NOT NULL DEFAULT 0,
    position_breaks    INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX idx_recon_run_account ON treasury.recon_run (account_id, ran_at DESC);

-- The latest comparison of each position the venue or the ledger holds on an account.
CREATE TABLE treasury.position_check (
    account_id             INTEGER     NOT NULL REFERENCES account_master.venue_account (account_id),
    venue_key              TEXT        NOT NULL,
    listing_ids            INTEGER[]   NOT NULL DEFAULT '{}',
    venue_qty              BIGINT      NOT NULL,
    ledger_qty             BIGINT      NOT NULL,
    ledger_fingerprint     TEXT,
    status                 VARCHAR(24) NOT NULL
                           CHECK (status IN ('OK', 'PENDING', 'BREAK', 'UNKNOWN_VENUE_POSITION')),
    consecutive_mismatches INTEGER     NOT NULL DEFAULT 0,
    first_mismatch_at      TIMESTAMPTZ,
    checked_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, venue_key)
);

-- Each strategy's budget on an exchange: the tightest MAX_COMMITTED_CAPITAL that applies to all of its listings
-- there, from a row for the strategy on the exchange, the strategy anywhere, the exchange for everyone, or everyone.
CREATE VIEW treasury.allocation AS
SELECT st.strategy_id, e.exchange_id, MIN((p.parameters->>'maxCapital')::bigint) AS max_capital
FROM strategy.strategy st
CROSS JOIN sm.exchange e
JOIN risk.policy p ON p.policy_type = 'MAX_COMMITTED_CAPITAL' AND p.enabled
    AND p.session_id IS NULL AND p.listing_id IS NULL
    AND (p.strategy_id IS NULL OR p.strategy_id = st.strategy_id)
    AND (p.exchange_id IS NULL OR p.exchange_id = e.exchange_id)
GROUP BY st.strategy_id, e.exchange_id;

INSERT INTO treasury.account_config (account_id, actor)
SELECT account_id, 'migration 038' FROM account_master.venue_account;
