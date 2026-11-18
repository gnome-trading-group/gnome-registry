-- The availability zone an exchange's order gateways, production market-data shards and the sessions trading it run
-- in: the zone measured nearest the venue. A zone ID (use2-az2), not a name: a name is a different physical zone in
-- another account. NULL leaves placement as it was (any zone of the region). The registry checks the zone belongs to
-- the exchange's region and its platform network; the column only checks the shape (with Local Zones' use1-nyc2-az1).
ALTER TABLE sm.exchange
    ADD COLUMN home_zone_id TEXT CHECK (home_zone_id ~ '^[a-z]+[0-9]+(-[a-z]+[0-9]+)?-az[0-9]+$');

-- Measured 2026-11-18 from every platform zone of each region (warm request p50): Kalshi 1.6 ms from use2-az2,
-- Polymarket US 11.4 ms from use1-az2, Polymarket International 21.9 ms from euw1-az3. Only where the exchange is
-- still in the region measured.
UPDATE sm.exchange SET home_zone_id = 'use2-az2' WHERE exchange_code = 'KALSHI' AND region = 'us-east-2';
UPDATE sm.exchange SET home_zone_id = 'use1-az2' WHERE exchange_code = 'POLYMARKET_US' AND region = 'us-east-1';
UPDATE sm.exchange SET home_zone_id = 'euw1-az3' WHERE exchange_code = 'POLYMARKET_INTL' AND region = 'eu-west-1';
-- Tokyo's venues together, in ap-northeast-1a: Hyperliquid 15.7 ms there against 16.9 from 1c, Binance Spot tied
-- (6.7 vs 6.5); Lighter's servers answered nothing measurable (CloudFront refused the probe), so it follows the others
-- and its production shards stay shared with theirs.
UPDATE sm.exchange SET home_zone_id = 'apne1-az4'
WHERE exchange_code IN ('HYPERLIQUID', 'LIGHTER', 'BINANCE_SPOT') AND region = 'ap-northeast-1';
