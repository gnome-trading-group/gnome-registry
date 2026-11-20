-- The spec sync's full pass pages through an exchange's active listings, and their specs in force, by listing id. With
-- no index on (exchange, active) each page either read every active listing (the specs) or walked every listing from
-- the cursor (the listings), seconds a page. This one holds only the active listings, so a page reads its own rows.
-- Built by hand first with CREATE INDEX CONCURRENTLY, so writes to sm.listing aren't held up; IF NOT EXISTS then only
-- records it.
CREATE INDEX IF NOT EXISTS idx_listing_active_exchange ON sm.listing (exchange_id, listing_id) WHERE active;
