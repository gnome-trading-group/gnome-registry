-- Listings and securities number in the millions, mostly expired prediction-market contracts, so the controller's
-- newest-first pages and substring searches need indexes. The id after date_created is the order's tie breaker
-- (bulk inserts share a date_created).
-- Built by hand first with CREATE INDEX CONCURRENTLY: building them here would hold up the classifier's and exchange
-- sync's writes for minutes. IF NOT EXISTS then only records them.
CREATE INDEX IF NOT EXISTS idx_listing_created ON sm.listing (date_created, listing_id);
CREATE INDEX IF NOT EXISTS idx_security_created ON sm.security (date_created, security_id);
CREATE INDEX IF NOT EXISTS idx_listing_symbol_trgm ON sm.listing USING GIN (exchange_security_symbol gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_security_symbol_trgm ON sm.security USING GIN (symbol gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_security_description_trgm ON sm.security USING GIN (description gin_trgm_ops);
