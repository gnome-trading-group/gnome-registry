-- Money a venue moves into or out of an account on its own: rewards, rebates, yield, interest, and deposits and
-- withdrawals. The venue poller reads each from the venue and books it as a transfer, once, under the venue's own id
-- in external_ref. program names the venue program behind a reward or interest payment; venue_market the market a
-- venue paid it for, where it says; asset and asset_amount the token it was paid in when that isn't US dollars
-- (amount stays its dollar value). raw keeps the venue's row as read.
ALTER TABLE treasury.transfer
    ADD COLUMN program VARCHAR(16)
        CHECK (program IN ('LIQUIDITY', 'MAKER_REBATE', 'TAKER_REBATE', 'HOLDING', 'REFERRAL', 'VOLUME', 'INTEREST',
                           'UNCLASSIFIED')),
    ADD COLUMN venue_market TEXT,
    ADD COLUMN asset TEXT NOT NULL DEFAULT 'USD',
    ADD COLUMN asset_amount NUMERIC,
    ADD COLUMN raw JSONB,
    -- Where a reward stands in being given to the strategies that earned it: PENDING until the venue's breakdown is
    -- in, DONE once all of it was given, PARTIAL when some markets in it had no strategy of ours, FAILED when none of
    -- it could be (the rest stays the firm's). Null when it isn't given out. unallocated lists the parts left to the
    -- firm, and why.
    ADD COLUMN allocation_state VARCHAR(10) CHECK (allocation_state IN ('PENDING', 'DONE', 'PARTIAL', 'FAILED')),
    ADD COLUMN unallocated JSONB;

CREATE UNIQUE INDEX idx_transfer_external_ref ON treasury.transfer (account_id, external_ref)
    WHERE external_ref IS NOT NULL;
CREATE INDEX idx_transfer_allocation_pending ON treasury.transfer (account_id) WHERE allocation_state = 'PENDING';

-- The part of a reward each strategy earned, and on which listing where the venue paid it for a market. What the
-- allocations leave of a transfer stays the firm's.
--   venue_market         the venue's market: Kalshi market ticker, Polymarket Intl condition id, Polymarket US slug
--   earned_from/_to      the time the split looked at, always set
--   period_start/_end    the venue program's own period, where the venue defines one (a Polymarket day, as the instants
--                        bounding it in the venue's time zone); null where it can't be told (a Kalshi period, a rebate)
--   basis                how a market's part was split between our strategies: by their accrued estimates, resting
--                        size × time, maker fills or taker fees; strategies says among how many
--   inputs               what the split was computed from, since the venue's breakdown may not be served for ever
CREATE TABLE treasury.transfer_allocation (
    allocation_id BIGSERIAL   PRIMARY KEY,
    transfer_id   BIGINT      NOT NULL REFERENCES treasury.transfer (transfer_id),
    strategy_id   INTEGER     NOT NULL REFERENCES strategy.strategy (strategy_id),
    listing_id    INTEGER     REFERENCES sm.listing (listing_id),
    venue_market  TEXT,
    amount        BIGINT      NOT NULL CHECK (amount >= 0),
    earned_from   TIMESTAMPTZ NOT NULL,
    earned_to     TIMESTAMPTZ NOT NULL,
    period_start  TIMESTAMPTZ,
    period_end    TIMESTAMPTZ,
    basis         VARCHAR(16) NOT NULL CHECK (basis IN ('ACCRUAL', 'RESTING_TIME', 'MAKER_FILLS', 'TAKER_FEES')),
    strategies    INTEGER     NOT NULL CHECK (strategies >= 1),
    inputs        JSONB,
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (earned_from < earned_to),
    CHECK ((period_start IS NULL) = (period_end IS NULL))
);

CREATE INDEX idx_transfer_allocation_transfer ON treasury.transfer_allocation (transfer_id);
CREATE INDEX idx_transfer_allocation_strategy ON treasury.transfer_allocation (strategy_id, listing_id);
-- Matching a payout's parts to estimates accrued for the same market and period.
CREATE INDEX idx_transfer_allocation_period ON treasury.transfer_allocation (strategy_id, venue_market, period_start)
    WHERE period_start IS NOT NULL;

-- A transfer can't be given out for more than it was.
CREATE FUNCTION treasury.check_allocation_total() RETURNS trigger AS $$
DECLARE
    allocated BIGINT;
    paid BIGINT;
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO allocated FROM treasury.transfer_allocation WHERE transfer_id = NEW.transfer_id;
    SELECT amount INTO paid FROM treasury.transfer WHERE transfer_id = NEW.transfer_id;
    IF allocated > paid THEN
        RAISE EXCEPTION 'transfer % allocates % of %', NEW.transfer_id, allocated, paid;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER transfer_allocation_total
    AFTER INSERT OR UPDATE ON treasury.transfer_allocation
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION treasury.check_allocation_total();
