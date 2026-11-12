-- What a paper session estimates its resting orders have earned from venue liquidity programs (a Kalshi liquidity
-- incentive program), as the session's scorer reports it every few minutes and on a clean stop. Append-only snapshots:
-- each row is the cumulative estimate for one listing and program as of the session's time as_of, so consecutive rows
-- give how much accrued in between. A session posting a snapshot twice books it once.
--
--   gross          our estimate on this listing, before the venue's closing rules
--   market_gross   our estimate on the whole market (a Kalshi market's YES and NO listings together)
--   market_paid    what the venue would pay the market at market_gross once its period ends (Kalshi: whole cents,
--                  nothing under $1)
--   *_nanos        how the program's time so far divided: counted, a side short of its size, a side possibly deeper
--                  than the feed shows, and no data (before the first book, a gap, the scorer lapped)
--   gaps           how often the session's scorer lost track of the market and had to rebuild it
-- Amounts are price units (1e9 = $1). These are estimates: a venue's payouts are treasury transfers.
CREATE TABLE ledger.reward_accrual (
    accrual_id          BIGSERIAL   PRIMARY KEY,
    session_id          TEXT        NOT NULL REFERENCES strategy.session (session_id),
    strategy_id         INTEGER     NOT NULL REFERENCES strategy.strategy (strategy_id),
    mode                VARCHAR(10) NOT NULL CHECK (mode IN ('paper', 'live')),
    listing_id          INTEGER     NOT NULL REFERENCES sm.listing (listing_id),
    exchange_id         INTEGER     NOT NULL REFERENCES sm.exchange (exchange_id),
    venue_market        TEXT        NOT NULL,
    venue_program_id    TEXT        NOT NULL,
    program             VARCHAR(16) NOT NULL CHECK (program IN ('LIQUIDITY')),
    period_start        TIMESTAMPTZ NOT NULL,
    period_end          TIMESTAMPTZ,
    as_of               TIMESTAMPTZ NOT NULL,
    gross               BIGINT      NOT NULL CHECK (gross >= 0),
    market_gross        BIGINT      NOT NULL CHECK (market_gross >= 0),
    market_paid         BIGINT      NOT NULL CHECK (market_paid >= 0),
    counting_nanos      BIGINT      NOT NULL DEFAULT 0,
    one_sided_nanos     BIGINT      NOT NULL DEFAULT 0,
    depth_unknown_nanos BIGINT      NOT NULL DEFAULT 0,
    no_data_nanos       BIGINT      NOT NULL DEFAULT 0,
    gaps                INTEGER     NOT NULL DEFAULT 0,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, listing_id, venue_program_id, as_of)
);

CREATE INDEX idx_reward_accrual_strategy ON ledger.reward_accrual (strategy_id, mode, as_of);
