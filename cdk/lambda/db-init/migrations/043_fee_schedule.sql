-- Point-in-time listing specs and fee schedules. Both are append-only with two times: effective_from is when the
-- value held at the venue, recorded_at is when we wrote it down. A lookup at time t takes the row with the latest
-- effective_from <= t, and the latest recorded_at among rows sharing that effective_from. So a real venue change is a
-- row effective from when it happened (backtests before it keep the old value), and a fix to bad data is a row with
-- the same effective_from as the row it corrects (it replaces that value for all time).

-- Most of the spec history so far is fixes to bad listing data, not venue changes, so every existing row counts as a
-- correction effective since the epoch: lookups keep returning the latest spec, as they did before.
ALTER TABLE sm.listing_spec ADD COLUMN effective_from TIMESTAMPTZ;
UPDATE sm.listing_spec SET effective_from = 'epoch';
ALTER TABLE sm.listing_spec ALTER COLUMN effective_from SET NOT NULL;

DROP INDEX sm.idx_listing_spec_lookup;
CREATE INDEX idx_listing_spec_lookup ON sm.listing_spec (listing_id, effective_from DESC, recorded_at DESC);

-- A writer that doesn't say (the classifier and the exchange sync, which only see the venue's current spec) records
-- a listing's first spec as holding since the epoch, since a listing can have data from before we first synced it,
-- and any later spec as a venue change from now.
CREATE FUNCTION sm.listing_spec_effective_from() RETURNS trigger AS $$
BEGIN
  IF NEW.effective_from IS NULL THEN
    NEW.effective_from := CASE
      WHEN EXISTS (SELECT 1 FROM sm.listing_spec WHERE listing_id = NEW.listing_id) THEN NOW()
      ELSE 'epoch'::timestamptz
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER listing_spec_effective_from BEFORE INSERT ON sm.listing_spec
  FOR EACH ROW EXECUTE FUNCTION sm.listing_spec_effective_from();

-- The venue's own groupings a fee schedule can target. fee_group is the coarse one (a Kalshi series, a Polymarket US
-- sport, Hyperliquid spot); fee_event is the venue's own event id (a Kalshi event ticker), which can hold many of our
-- sm.events: Kalshi markets that aren't mutually exclusive are each their own sm.event but share the venue event's
-- fee override. Null when the venue doesn't set fees at that level.
ALTER TABLE sm.listing ADD COLUMN fee_group VARCHAR;
ALTER TABLE sm.listing ADD COLUMN fee_event VARCHAR;

-- Hyperliquid prices spot and outcome tokens apart from perps. New listings get their group from the exchange sync and
-- the classifier; these are the ones already listed. Kalshi and Polymarket listings get theirs from the classifier,
-- and resolved ones from its backfill-fees script.
UPDATE sm.listing l SET fee_group = CASE s.type WHEN 0 THEN 'spot' ELSE 'outcome' END
FROM sm.exchange e, sm.security s
WHERE e.exchange_id = l.exchange_id AND e.exchange_code = 'HYPERLIQUID' AND s.security_id = l.security_id
  AND s.type IN (0, 4);

-- A fee schedule targets one scope: the whole exchange (no target), a fee group, a fee event or a listing. A listing's
-- fees at time t come from its most specific scope with a schedule in force at t (listing, fee event, fee group,
-- exchange). A null definition clears that scope from then on, so the listing falls back to the next scope out (a
-- Kalshi event override being lifted).
CREATE TABLE sm.fee_schedule (
    fee_schedule_id BIGSERIAL   PRIMARY KEY,
    exchange_id     INTEGER     NOT NULL REFERENCES sm.exchange (exchange_id),
    fee_group       VARCHAR,
    fee_event       VARCHAR,
    listing_id      INTEGER     REFERENCES sm.listing (listing_id),
    effective_from  TIMESTAMPTZ NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    definition      JSONB,
    source          VARCHAR     NOT NULL CHECK (source IN ('VENUE_API', 'MANUAL', 'BACKFILL')),
    source_ref      VARCHAR,
    actor           VARCHAR,
    CHECK (num_nonnulls(fee_group, fee_event, listing_id) <= 1)
);

CREATE INDEX idx_fee_schedule_exchange ON sm.fee_schedule (exchange_id, effective_from)
  WHERE fee_group IS NULL AND fee_event IS NULL AND listing_id IS NULL;
CREATE INDEX idx_fee_schedule_group ON sm.fee_schedule (exchange_id, fee_group, effective_from) WHERE fee_group IS NOT NULL;
CREATE INDEX idx_fee_schedule_event ON sm.fee_schedule (exchange_id, fee_event, effective_from) WHERE fee_event IS NOT NULL;
CREATE INDEX idx_fee_schedule_listing ON sm.fee_schedule (listing_id, effective_from) WHERE listing_id IS NOT NULL;

-- Schedules the venues don't publish through an API, and the defaults beneath those they do. Polymarket US fees are
-- exchange-wide (docs.polymarket.us/fees, CFTC filings), rounded per fill to the cent half to even, with a maker
-- rebate; 0.0695 taker and -0.0125 maker were checked against our own fills on 2026-10-15. Its schedule before
-- 2026-04-03 isn't known.
--
-- Kalshi publishes per-series and per-event changes (the classifier syncs them) but only since 2025-10-04; a series
-- with no recorded change is on the original schedule, 0.07 taker and no maker fee. Kalshi rounded each fee up to the
-- cent until it moved to rounding balances to $0.0001 with the overpayment carried across an order's fills
-- (docs.kalshi.com/getting_started/fee_rounding; checked against our fills 2026-10-15). The cutover date is the
-- changelog's, not confirmed. The S&P and Nasdaq index series paid half (0.035) from 2022-09-22 until 2026-07-03,
-- where their recorded history starts.
--
-- Polymarket International fees are set per market when it lists (the classifier records them per listing);
-- markets without a schedule trade free.
INSERT INTO sm.fee_schedule (exchange_id, fee_group, effective_from, definition, source, source_ref, actor)
SELECT e.exchange_id, s.fee_group, s.effective_from::timestamptz, s.definition::jsonb, 'MANUAL', s.source_ref, 'migration 043'
FROM sm.exchange e
JOIN (VALUES
  ('POLYMARKET_US', NULL, '2026-04-03T04:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.05,"maker":-0.0125,"exponent":1}],"rounding":{"mode":"HALF_EVEN","increment":0.01,"scope":"FILL"}}',
   'Parabolic fee launch'),
  ('POLYMARKET_US', NULL, '2026-07-01T04:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.06,"maker":-0.0125,"exponent":1}],"rounding":{"mode":"HALF_EVEN","increment":0.01,"scope":"FILL"}}',
   'cftc.gov/filings/orgrules/rules0707269057.pdf'),
  ('POLYMARKET_US', NULL, '2026-09-17T04:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.0695,"maker":-0.0125,"exponent":1}],"rounding":{"mode":"HALF_EVEN","increment":0.01,"scope":"FILL"}}',
   'cftc.gov/filings/orgrules/rules09212628660.pdf'),
  ('POLYMARKET_US', 'table-tennis', '2026-10-07T14:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.10,"maker":-0.0125,"exponent":1}],"rounding":{"mode":"HALF_EVEN","increment":0.01,"scope":"FILL"}}',
   'docs.polymarket.us/fees (start date unconfirmed)'),
  ('KALSHI', NULL, '1970-01-01T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.07,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.01,"scope":"FILL"}}',
   'kalshi.com/docs/kalshi-fee-schedule.pdf'),
  ('KALSHI', NULL, '2026-03-03T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.07,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.0001,"scope":"ORDER_ACCUMULATOR"}}',
   'docs.kalshi.com/getting_started/fee_rounding'),
  ('KALSHI', 'KXINX', '2022-09-22T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.01,"scope":"FILL"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXINX', '2026-03-03T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.0001,"scope":"ORDER_ACCUMULATOR"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXINXU', '2022-09-22T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.01,"scope":"FILL"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXINXU', '2026-03-03T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.0001,"scope":"ORDER_ACCUMULATOR"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXNASDAQ100', '2022-09-22T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.01,"scope":"FILL"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXNASDAQ100', '2026-03-03T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.0001,"scope":"ORDER_ACCUMULATOR"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXNASDAQ100U', '2022-09-22T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.01,"scope":"FILL"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXNASDAQ100U', '2026-03-03T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.0001,"scope":"ORDER_ACCUMULATOR"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXINXPOS', '2022-09-22T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.01,"scope":"FILL"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXINXPOS', '2026-03-03T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.0001,"scope":"ORDER_ACCUMULATOR"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXINXMINY', '2022-09-22T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.01,"scope":"FILL"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXINXMINY', '2026-03-03T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.0001,"scope":"ORDER_ACCUMULATOR"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXINXMAXY', '2022-09-22T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.01,"scope":"FILL"}}',
   'Index markets at half fees'),
  ('KALSHI', 'KXINXMAXY', '2026-03-03T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0.035,"maker":0,"exponent":1}],"rounding":{"mode":"CEIL","increment":0.0001,"scope":"ORDER_ACCUMULATOR"}}',
   'Index markets at half fees'),
  ('POLYMARKET_INTL', NULL, '1970-01-01T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"PRICE_CURVE","taker":0,"maker":0,"exponent":1}],"rounding":{"mode":"NONE"}}',
   'Markets without a fee schedule'),
  -- Hyperliquid outcome tokens charge only when a position closes or settles, which no schedule here can express yet.
  ('HYPERLIQUID', 'outcome', '1970-01-01T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"NOTIONAL","taker":0,"maker":0}],"rounding":{"mode":"NONE"}}',
   'Outcome fees on close/settle not modelled'),
  -- Hyperliquid base tier (no volume tier, staking or referral discount); spot has its own schedule since 2025-05-05.
  ('HYPERLIQUID', NULL, '1970-01-01T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"NOTIONAL","taker":0.00035,"maker":0.0001}],"rounding":{"mode":"NONE"}}',
   'Base tier before the 2025-05-05 schedule'),
  ('HYPERLIQUID', NULL, '2025-05-05T03:00:00Z',
   '{"currency":"USD","components":[{"kind":"NOTIONAL","taker":0.00045,"maker":0.00015}],"rounding":{"mode":"NONE"}}',
   'hyperliquid.gitbook.io/hyperliquid-docs/trading/fees'),
  ('HYPERLIQUID', 'spot', '2025-05-05T03:00:00Z',
   '{"currency":"USD","components":[{"kind":"NOTIONAL","taker":0.0007,"maker":0.0004}],"rounding":{"mode":"NONE"}}',
   'hyperliquid.gitbook.io/hyperliquid-docs/trading/fees'),
  -- Lighter standard accounts trade free; premium accounts pay 0.004% maker / 0.028% taker before LIT staking.
  ('LIGHTER', NULL, '1970-01-01T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"NOTIONAL","taker":0,"maker":0}],"rounding":{"mode":"NONE"}}',
   'apidocs.lighter.xyz/docs/account-types (standard account)')
) AS s (exchange_code, fee_group, effective_from, definition, source_ref) ON s.exchange_code = e.exchange_code;
