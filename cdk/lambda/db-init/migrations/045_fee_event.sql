-- Brings a database that ran the first version of 043 (prod) up to its final one: fee schedules keyed by the venue's
-- own event id instead of sm.event, the fee_event column on listings, and the seed rows added since. A database that
-- ran the final 043 (dev, fresh ones) already matches, and every step here leaves it unchanged.
ALTER TABLE sm.listing ADD COLUMN IF NOT EXISTS fee_event VARCHAR;
DROP INDEX IF EXISTS sm.idx_listing_fee_group;

UPDATE sm.listing l SET fee_group = CASE s.type WHEN 0 THEN 'spot' ELSE 'outcome' END
FROM sm.exchange e, sm.security s
WHERE e.exchange_id = l.exchange_id AND e.exchange_code = 'HYPERLIQUID' AND s.security_id = l.security_id
  AND s.type IN (0, 4) AND l.fee_group IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'sm' AND table_name = 'fee_schedule' AND column_name = 'event_id') THEN
    -- Nothing could write an event-scoped schedule before this (only the Kalshi fee sync does, and it needs
    -- fee_event), so there are none to carry over; refuse rather than lose one if that turns out wrong.
    IF EXISTS (SELECT 1 FROM sm.fee_schedule WHERE event_id IS NOT NULL) THEN
      RAISE EXCEPTION 'sm.fee_schedule has event_id rows; map them to fee_event by hand first';
    END IF;
    ALTER TABLE sm.fee_schedule DROP CONSTRAINT IF EXISTS fee_schedule_check;
    DROP INDEX IF EXISTS sm.idx_fee_schedule_exchange;
    DROP INDEX IF EXISTS sm.idx_fee_schedule_event;
    ALTER TABLE sm.fee_schedule DROP COLUMN event_id;
    ALTER TABLE sm.fee_schedule ADD COLUMN fee_event VARCHAR;
    ALTER TABLE sm.fee_schedule ADD CONSTRAINT fee_schedule_check CHECK (num_nonnulls(fee_group, fee_event, listing_id) <= 1);
    CREATE INDEX idx_fee_schedule_exchange ON sm.fee_schedule (exchange_id, effective_from)
      WHERE fee_group IS NULL AND fee_event IS NULL AND listing_id IS NULL;
    CREATE INDEX idx_fee_schedule_event ON sm.fee_schedule (exchange_id, fee_event, effective_from)
      WHERE fee_event IS NOT NULL;
  END IF;
END $$;

-- The seed rows the final 043 added; see it for where each comes from.
INSERT INTO sm.fee_schedule (exchange_id, fee_group, effective_from, definition, source, source_ref, actor)
SELECT e.exchange_id, s.fee_group, s.effective_from::timestamptz, s.definition::jsonb, 'MANUAL', s.source_ref, 'migration 043'
FROM sm.exchange e
JOIN (VALUES
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
  ('HYPERLIQUID', 'outcome', '1970-01-01T00:00:00Z',
   '{"currency":"USD","components":[{"kind":"NOTIONAL","taker":0,"maker":0}],"rounding":{"mode":"NONE"}}',
   'Outcome fees on close/settle not modelled')
) AS s (exchange_code, fee_group, effective_from, definition, source_ref) ON s.exchange_code = e.exchange_code
WHERE NOT EXISTS (
  SELECT 1 FROM sm.fee_schedule f
  WHERE f.exchange_id = e.exchange_id AND f.fee_group IS NOT DISTINCT FROM s.fee_group AND f.fee_event IS NULL
    AND f.listing_id IS NULL AND f.effective_from = s.effective_from::timestamptz
);
