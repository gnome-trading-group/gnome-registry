-- How many subjects a source's connections may carry and how many connections it allows, read by the collector's
-- connection groups and, later, by shard placement. connection_scope is what the venue counts connections against
-- (an IP, an API key or an account); NULL connections_per_scope and client_messages_per_minute mean no known limit.
-- Values from the venues' docs and from measuring them (Phase 5 Step 0, 2026-10-26); each leaves headroom for a
-- connection being replaced make-before-break.
ALTER TABLE md.source
    ADD COLUMN max_per_connection         INTEGER    NOT NULL DEFAULT 50 CHECK (max_per_connection > 0),
    ADD COLUMN connection_scope           VARCHAR(7) NOT NULL DEFAULT 'IP'
        CHECK (connection_scope IN ('IP', 'KEY', 'ACCOUNT')),
    ADD COLUMN connections_per_scope      INTEGER    CHECK (connections_per_scope > 0),
    ADD COLUMN client_messages_per_minute INTEGER    CHECK (client_messages_per_minute > 0);

-- Kalshi: one sid per channel per connection takes 6,000+ markets, so 250 bounds what one sequence gap re-snapshots;
-- 200 connections per user on the Basic tier.
UPDATE md.source SET max_per_connection = 250, connection_scope = 'KEY', connections_per_scope = 180
WHERE adapter = 'KALSHI';
-- Hyperliquid: 10 connections, 1,000 subscriptions (two per coin) and 2,000 client messages a minute per IP.
UPDATE md.source SET max_per_connection = 50, connection_scope = 'IP', connections_per_scope = 8,
    client_messages_per_minute = 1800
WHERE adapter = 'HYPERLIQUID';
-- Polymarket Intl: opening subscribes of ~700 assets lose their books; added in batches of 100, 1,000 were fine.
UPDATE md.source SET max_per_connection = 250, connection_scope = 'IP' WHERE adapter = 'POLYMARKET_INTL';
-- Polymarket US: two subscriptions per market; no limit seen at 300 on one connection.
UPDATE md.source SET max_per_connection = 100, connection_scope = 'IP' WHERE adapter = 'POLYMARKET_US';
-- Lighter: 500 subscriptions (two per market) per connection, 200 client messages a minute per IP.
UPDATE md.source SET max_per_connection = 100, connection_scope = 'IP', connections_per_scope = 200,
    client_messages_per_minute = 180
WHERE adapter = 'LIGHTER';
