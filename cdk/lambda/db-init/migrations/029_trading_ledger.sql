-- The trading ledger: what each strategy holds and did, durable across its sessions. Fills own positions and
-- realized PnL, marks own prices, and PnL at any moment is derived from the two, so nothing is stored twice.
-- Replaces pnl.snapshot, which copied every position every 30s and could never be read back.
CREATE SCHEMA ledger;

-- One row per booked fill, plus the records that move a position without trading:
--   VENUE      a fill the venue reported to a running session
--   RECOVERY   a fill found on the venue at startup that the session which placed the order never recorded
--   RESET      a session that chose not to inherit setting the position to flat
--   ADJUSTMENT an operator setting the position, e.g. after a market settles
--   GAP        events the OMS lost (its ring overflowed); the position needs review before it can be trusted
-- Every row carries the position after it, as the OMS computed it, so the ledger holds no PnL math of its own.
CREATE TABLE ledger.fill (
    fill_id             BIGSERIAL   PRIMARY KEY,
    source              VARCHAR(12) NOT NULL CHECK (source IN ('VENUE', 'RECOVERY', 'RESET', 'ADJUSTMENT', 'GAP')),
    session_id          TEXT        REFERENCES strategy.session (session_id),
    -- RECOVERY only: the session whose order filled, as opposed to the session that found and recorded it.
    origin_session_id   TEXT        REFERENCES strategy.session (session_id),
    strategy_id         INTEGER     NOT NULL,
    listing_id          INTEGER     NOT NULL,
    mode                VARCHAR(10) NOT NULL CHECK (mode IN ('paper', 'live')),
    client_oid_counter  BIGINT,
    cum_qty_after       BIGINT,
    side                SMALLINT,
    fill_qty            BIGINT,
    fill_price          BIGINT,
    fee                 BIGINT,
    event_time_ns       BIGINT,
    net_quantity_after  BIGINT,
    total_cost_after    BIGINT,
    realized_pnl_after  BIGINT,
    fees_after          BIGINT,
    position_version    BIGINT,
    actor               TEXT,
    reason              TEXT,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Natural keys, so a retried batch can never book the same thing twice. The OMS already drops a fill that doesn't
-- advance its order's cumulative quantity, so (session, order, cumulative) is unique per venue fill.
CREATE UNIQUE INDEX idx_fill_venue ON ledger.fill (session_id, client_oid_counter, cum_qty_after)
    WHERE source = 'VENUE';
CREATE UNIQUE INDEX idx_fill_recovery ON ledger.fill (origin_session_id, client_oid_counter, cum_qty_after)
    WHERE source = 'RECOVERY';
CREATE UNIQUE INDEX idx_fill_reset ON ledger.fill (session_id, listing_id) WHERE source = 'RESET';
CREATE UNIQUE INDEX idx_fill_gap ON ledger.fill (session_id, listing_id, client_oid_counter) WHERE source = 'GAP';
CREATE INDEX idx_fill_session_time ON ledger.fill (session_id, listing_id, event_time_ns);
CREATE INDEX idx_fill_strategy ON ledger.fill (strategy_id, listing_id, mode, recorded_at);

-- What each strategy holds now, taken from its newest fill row. The version only moves forward, so a late or
-- retried write can never roll a position back.
CREATE TABLE ledger.position (
    strategy_id   INTEGER     NOT NULL,
    listing_id    INTEGER     NOT NULL,
    mode          VARCHAR(10) NOT NULL CHECK (mode IN ('paper', 'live')),
    net_quantity  BIGINT      NOT NULL,
    total_cost    BIGINT      NOT NULL,
    version       BIGINT      NOT NULL,
    session_id    TEXT,
    needs_review  BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (strategy_id, listing_id, mode)
);

-- Top of book and last trade per listing, written only when one of them changes. Shared by every strategy and
-- session on the listing; the mark is derived from it (the mid, else the last trade). 0 means unknown.
CREATE TABLE ledger.mark (
    listing_id  INTEGER     NOT NULL,
    ts          TIMESTAMPTZ NOT NULL,
    bid         BIGINT      NOT NULL,
    ask         BIGINT      NOT NULL,
    last_trade  BIGINT      NOT NULL,
    PRIMARY KEY (listing_id, ts)
);

-- Every order a session sent, so a later session can recognise and cancel what it left resting on the venue.
-- exchange_order_id is what the venue knows the order by (a Kalshi client_order_id, a Polymarket order hash);
-- it stays null until the venue acknowledges the order.
CREATE TABLE ledger.order (
    session_id          TEXT        NOT NULL REFERENCES strategy.session (session_id),
    client_oid_counter  BIGINT      NOT NULL,
    strategy_id         INTEGER     NOT NULL,
    listing_id          INTEGER     NOT NULL,
    exchange_id         INTEGER     NOT NULL,
    mode                VARCHAR(10) NOT NULL CHECK (mode IN ('paper', 'live')),
    side                SMALLINT,
    price               BIGINT,
    size                BIGINT,
    exchange_order_id   TEXT,
    status              VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'RECOVERED')),
    filled_qty          BIGINT,
    opened_at           TIMESTAMPTZ,
    acked_at            TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ,
    PRIMARY KEY (session_id, client_oid_counter)
);

CREATE UNIQUE INDEX idx_order_exchange_id ON ledger.order (exchange_id, exchange_order_id)
    WHERE exchange_order_id IS NOT NULL;
CREATE INDEX idx_order_open ON ledger.order (listing_id, mode) WHERE status = 'OPEN';

DROP TABLE pnl.snapshot;
DROP SCHEMA pnl;
