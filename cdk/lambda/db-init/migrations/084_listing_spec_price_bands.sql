-- A listing's prices as a grid of bands instead of one tick: venues tick finer near the edges of a binary contract
-- (Kalshi's tapered structures), by significant figures (Hyperliquid), or by price (equities). price_bands is a JSON
-- array of {start, end, step} in price units (1e9 = $1): contiguous from 0, the last end 1e9 for a binary contract
-- or null for none. A listing with one tick is one band. The listing-specs endpoint validates the shape.
ALTER TABLE sm.listing_spec ADD COLUMN price_bands JSONB;

-- Rewriting every row with the indexes in place inserts each new row version into them in the join's order: a random
-- read per row once the indexes outgrow the buffer cache, long past the migration Lambda's 15 minutes. Without them the
-- update only appends, and each index is then built once from sorted input.
SET LOCAL work_mem = '64MB';
SET LOCAL maintenance_work_mem = '256MB';
DROP INDEX sm.idx_listing_spec_lookup;
ALTER TABLE sm.listing_spec DROP CONSTRAINT listing_spec_pkey;

UPDATE sm.listing_spec spec
SET price_bands = jsonb_build_array(jsonb_build_object(
      'start', 0,
      'end', CASE WHEN security.asset_class = 5 THEN 1000000000 END,
      'step', spec.tick_size))
FROM sm.listing listing
JOIN sm.security security USING (security_id)
WHERE listing.listing_id = spec.listing_id;

ALTER TABLE sm.listing_spec ADD CONSTRAINT listing_spec_pkey PRIMARY KEY (id);
CREATE INDEX idx_listing_spec_lookup ON sm.listing_spec (listing_id, effective_from DESC, recorded_at DESC);

ALTER TABLE sm.listing_spec ALTER COLUMN price_bands SET NOT NULL;
ALTER TABLE sm.listing_spec ADD CONSTRAINT chk_listing_spec_price_bands
  CHECK (jsonb_typeof(price_bands) = 'array' AND jsonb_array_length(price_bands) > 0);

ALTER TABLE sm.listing_spec DROP COLUMN tick_size;

-- An undated spec was a listing's first (since the epoch) or, after that, a change dated now. Most such later rows were
-- fixes of our own bad data, which then applied only from the day they were written. Now only a listing's first spec
-- may be undated; a later one must say whether it is a venue change (its effective_from) or a correction (the
-- effective_from of the row it fixes).
CREATE OR REPLACE FUNCTION sm.listing_spec_effective_from() RETURNS trigger AS $$
BEGIN
  IF NEW.effective_from IS NULL THEN
    IF EXISTS (SELECT 1 FROM sm.listing_spec WHERE listing_id = NEW.listing_id) THEN
      RAISE EXCEPTION 'listing % already has a spec: a later one needs an effective_from or must be a correction',
        NEW.listing_id USING ERRCODE = '22023';
    END IF;
    NEW.effective_from := 'epoch'::timestamptz;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
