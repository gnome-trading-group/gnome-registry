-- What the controller needs to show a strategy's trading without reading logs: how each fill traded, how each
-- order ended, the orders the OMS refused before they reached the venue, and whether a session is alive.

-- Whether a fill added liquidity or took it; null when the venue didn't say (and on non-venue rows).
ALTER TABLE ledger.fill ADD COLUMN liquidity VARCHAR(5) CHECK (liquidity IN ('MAKER', 'TAKER'));

-- How an order ended, and why the venue refused it. status stays the recovery lifecycle (OPEN, CLOSED,
-- RECOVERED); close_state is what the OMS saw. order_seq gives order lists a stable order to page through.
ALTER TABLE ledger.order
    ADD COLUMN close_state   VARCHAR(10) CHECK (close_state IN ('FILLED', 'CANCELED', 'REJECTED', 'EXPIRED')),
    ADD COLUMN reject_reason VARCHAR(32),
    ADD COLUMN order_seq     BIGSERIAL;
CREATE UNIQUE INDEX idx_order_seq ON ledger.order (order_seq);
CREATE INDEX idx_order_session_seq ON ledger.order (session_id, order_seq);
CREATE INDEX idx_order_strategy_seq ON ledger.order (strategy_id, mode, order_seq);

CREATE INDEX idx_fill_session_id ON ledger.fill (session_id, fill_id);
CREATE INDEX idx_fill_strategy_id ON ledger.fill (strategy_id, mode, fill_id);

-- Orders and modifies the OMS refused (risk limits, halts, listing rules), which never become order rows. The OMS
-- sends running totals, so a retried or late batch can only ever raise a count.
CREATE TABLE ledger.reject_count (
    session_id  TEXT        NOT NULL REFERENCES strategy.session (session_id),
    listing_id  INTEGER     NOT NULL,
    reason      VARCHAR(32) NOT NULL,
    count       BIGINT      NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, listing_id, reason)
);

-- The session's latest heartbeat and the health it reported, overwritten each time; a session that stops sending
-- them is stuck or gone even while its instance runs.
ALTER TABLE strategy.session
    ADD COLUMN last_heartbeat_at TIMESTAMPTZ,
    ADD COLUMN health            JSONB;
