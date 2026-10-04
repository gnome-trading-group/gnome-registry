-- Minimum order quantity in size units (1e6 per share/contract). Distinct from lot_size: Polymarket accepts
-- 0.01-share increments but rejects orders under 5 shares.
ALTER TABLE sm.listing_spec ADD COLUMN min_size bigint NOT NULL DEFAULT 0;
