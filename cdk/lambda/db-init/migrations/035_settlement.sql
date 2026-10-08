-- What each outcome of a prediction-market event paid once its result became final, recorded by the classifier.
-- The raw value, since venues can settle anywhere between 0 and 1 (Kalshi scalars, Polymarket US "fair market"
-- settlements). settled_at is when we recorded it, not the venue's settlement time.
ALTER TABLE sm.event_contract
    ADD COLUMN settlement_price BIGINT CHECK (settlement_price BETWEEN 0 AND 1000000000),
    ADD COLUMN settled_at       TIMESTAMPTZ;

-- One outcome row per security, so a security (and the listing that trades it) has exactly one settlement value.
ALTER TABLE sm.event_contract ADD CONSTRAINT uq_event_contract_security UNIQUE (security_id);

-- Positions are closed at the first value recorded, so a later different value can't silently diverge from what
-- the ledger booked.
CREATE OR REPLACE FUNCTION sm.keep_settlement() RETURNS trigger AS $$
BEGIN
    IF OLD.settlement_price IS NOT NULL AND NEW.settlement_price IS DISTINCT FROM OLD.settlement_price THEN
        RAISE EXCEPTION 'event contract % already settled at %', OLD.event_contract_id, OLD.settlement_price;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_keep_settlement
    BEFORE UPDATE OF settlement_price ON sm.event_contract
    FOR EACH ROW EXECUTE FUNCTION sm.keep_settlement();

-- SETTLEMENT: the settlement sweeper closing a position at its listing's settlement price once no session holds
-- it. Like MANUAL it belongs to no session, so realized_pnl_after and fees_after hold that row's own amounts.
-- One per position, so a re-run of the sweeper can never book a settlement twice.
ALTER TABLE ledger.fill DROP CONSTRAINT fill_source_check;
ALTER TABLE ledger.fill ADD CONSTRAINT fill_source_check
    CHECK (source IN ('VENUE', 'RECOVERY', 'RESET', 'ADJUSTMENT', 'MANUAL', 'SETTLEMENT', 'GAP'));
CREATE UNIQUE INDEX idx_fill_settlement ON ledger.fill (strategy_id, listing_id, mode) WHERE source = 'SETTLEMENT';
