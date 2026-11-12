-- Venue incentive programs (Kalshi's liquidity incentive program, Polymarket Intl liquidity rewards), as the venues
-- publish them, so paper sessions and backtests can estimate what a strategy would have earned. Append-only with two
-- times, like sm.fee_schedule: a program's terms at time t, as known at k, are its row with the latest
-- effective_from <= t among rows with recorded_at <= k (ties to the latest recorded_at), and they apply when t is in
-- [period_start, period_end).
--
-- The registry sets effective_from, since only it knows what it held before: a program's first row holds from the
-- earlier of its start and when it was recorded (announced terms hold from when we learned them; a program first seen
-- running held its terms since it started); a change to its terms holds from when it was recorded, so a cancellation
-- (Kalshi moving end_date before start_date) wins from then on; a change only to paid_out keeps the effective_from of
-- the row it updates, since a payout is news about the past, not new terms.
--
--   venue_program_id  the venue's id: a Kalshi program id; Polymarket Intl condition_id:asset:start_date, since its
--                     reward configs carry no id of their own
--   venue_market      the market as split_part(sm.listing.exchange_security_id, ':', 1) names it, so a program reaches
--                     every listing of its market (Kalshi YES and NO, both Polymarket tokens) whenever either is listed
--   reward            dollars at PRICE_SCALE (1e9), per period or per day by reward_per
--   period_end        null while the program has no end (Polymarket's 2500-12-31)
--   definition        the venue's scoring terms, checked per venue on write
--   paid_out          whether the venue says it has paid the period; null where it doesn't say
--   raw               the venue's row as read
CREATE TABLE sm.incentive_program (
    incentive_program_id BIGSERIAL   PRIMARY KEY,
    exchange_id          INTEGER     NOT NULL REFERENCES sm.exchange (exchange_id),
    venue_program_id     TEXT        NOT NULL,
    program              VARCHAR(16) NOT NULL CHECK (program IN ('LIQUIDITY')),
    venue_market         TEXT        NOT NULL,
    period_start         TIMESTAMPTZ NOT NULL,
    period_end           TIMESTAMPTZ,
    reward               BIGINT      NOT NULL CHECK (reward >= 0),
    reward_per           VARCHAR(8)  NOT NULL CHECK (reward_per IN ('PERIOD', 'DAY')),
    definition           JSONB       NOT NULL,
    paid_out             BOOLEAN,
    effective_from       TIMESTAMPTZ NOT NULL,
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source               VARCHAR     NOT NULL CHECK (source IN ('VENUE_API', 'MANUAL', 'BACKFILL')),
    source_ref           VARCHAR,
    raw                  JSONB,
    actor                VARCHAR
);

CREATE INDEX idx_incentive_program_lookup
    ON sm.incentive_program (exchange_id, venue_program_id, effective_from DESC, recorded_at DESC);
CREATE INDEX idx_incentive_program_market ON sm.incentive_program (exchange_id, venue_market, period_start);
-- Programs still running: Kalshi alone adds tens of thousands a month, and nearly all of them have ended.
CREATE INDEX idx_incentive_program_open
    ON sm.incentive_program (exchange_id, (COALESCE(period_end, 'infinity'::timestamptz)));
