-- A listing turned off while its outcome has no settlement value yet. The classifier looks for these after every fetch,
-- to settle them and to turn back on any its venue lists as open again: a few hundred listings an exchange, which
-- without an index on when a listing was turned off meant reading every listing of the exchange each minute. The
-- listings endpoint sets the flag when it turns a listing off and clears it when it turns one on; the event-contracts
-- endpoint clears it when it records the outcome's settlement value. The index holds only the flagged listings.
ALTER TABLE sm.listing ADD COLUMN awaiting_settlement BOOLEAN NOT NULL DEFAULT false;

-- The classifier looks back 30 days; a listing turned off before that and never settled is past its passes.
UPDATE sm.listing listing
SET awaiting_settlement = true
FROM sm.event_contract ec
WHERE ec.security_id = listing.security_id
  AND NOT listing.active
  AND ec.settlement_price IS NULL
  AND listing.date_modified > (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days';

CREATE INDEX idx_listing_awaiting_settlement ON sm.listing (exchange_id, date_modified) WHERE awaiting_settlement;
