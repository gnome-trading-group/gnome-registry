-- The treasury finds the listings behind a venue's position by the venue's key for them: the market before the colon
-- (Kalshi TICKER:yes, Polymarket US slug:long), or the outcome token after it (Polymarket Intl condition:token).
-- Without these, each snapshot read every listing on the exchange, hundreds of thousands of them.
CREATE INDEX idx_listing_venue_market ON sm.listing (exchange_id, split_part(exchange_security_id, ':', 1));
CREATE INDEX idx_listing_venue_token ON sm.listing (exchange_id, split_part(exchange_security_id, ':', 2));
