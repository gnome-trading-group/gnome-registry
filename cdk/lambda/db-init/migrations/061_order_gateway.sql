-- A strategy's weight in its share of a venue account's request budget: the order gateway guarantees each session
-- its weighted share when the account is saturated and lends idle share to busy sessions.
ALTER TABLE strategy.strategy ADD COLUMN rate_weight INTEGER NOT NULL DEFAULT 1 CHECK (rate_weight > 0);

-- Order gateways: one process per venue that holds that venue's trading accounts for every live session, plus one
-- simulated gateway serving every paper session. A row is what an operator decides about a gateway, which must
-- outlive it (it scales to zero): its live state is its service-endpoints item, keyed order-gateway#<gateway_key>,
-- which it rewrites every 15 s and which expires once it stops.
--   gateway_key          live:<exchange code, lower case>:<instance>, or paper
--   profile              standard (idle threads park), low_latency (they spin), paper (the simulated gateway)
--   orchestrator_version the release a cold start runs; null until one is pinned. Changing it never restarts a
--                        running gateway: the next start picks it up
--   wanted_at            when a session last asked for the gateway; a gateway stopping for idleness re-reads it and
--                        stays up if it is newer than its last idle check
CREATE TABLE account_master.gateway (
    gateway_key          TEXT        PRIMARY KEY CHECK (gateway_key ~ '^(paper|live:[a-z0-9_]+:[a-z0-9-]+)$'),
    mode                 VARCHAR(5)  NOT NULL CHECK (mode IN ('paper', 'live')),
    exchange_id          INTEGER     REFERENCES sm.exchange (exchange_id),
    region               TEXT        NOT NULL,
    profile              VARCHAR(12) NOT NULL CHECK (profile IN ('standard', 'low_latency', 'paper')),
    orchestrator_version VARCHAR(30),
    wanted_at            TIMESTAMPTZ,
    date_created         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    date_modified        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The simulated gateway serves every venue, so only it has no exchange; a live gateway trades one.
    CHECK ((mode = 'paper' AND exchange_id IS NULL AND profile = 'paper')
        OR (mode = 'live' AND exchange_id IS NOT NULL AND profile IN ('standard', 'low_latency')))
);

-- Which gateway holds each venue account: at most one, so an account is never traded from two processes or two IPs at
-- once. Kept apart from venue_account, which records what accounts exist; this records where each is served, which
-- changes when a venue is split across gateway instances. A gateway holds its assigned accounts that are ACTIVE or
-- DRAINING (a draining account still has orders to cancel and positions to unwind).
CREATE TABLE account_master.gateway_account (
    account_id  INTEGER     PRIMARY KEY REFERENCES account_master.venue_account (account_id),
    gateway_key TEXT        NOT NULL REFERENCES account_master.gateway (gateway_key),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor       TEXT
);

CREATE INDEX idx_gateway_account_gateway ON account_master.gateway_account (gateway_key);

-- A live gateway trades one venue, so an account can only be held by a live gateway on the account's own exchange;
-- the simulated gateway holds none.
CREATE FUNCTION account_master.check_gateway_account() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM account_master.gateway g JOIN account_master.venue_account a ON a.account_id = NEW.account_id
        WHERE g.gateway_key = NEW.gateway_key AND g.mode = 'live' AND g.exchange_id = a.exchange_id
    ) THEN
        RAISE EXCEPTION 'Account % can''t be held by gateway %: only a live gateway on its exchange can hold it',
            NEW.account_id, NEW.gateway_key;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_account_same_exchange
    BEFORE INSERT OR UPDATE ON account_master.gateway_account
    FOR EACH ROW EXECUTE FUNCTION account_master.check_gateway_account();

-- One live gateway per venue the gateway supports, in the venue's trading region, and the simulated one, which has no
-- venue to sit near.
INSERT INTO account_master.gateway (gateway_key, mode, exchange_id, region, profile)
SELECT 'live:' || lower(e.exchange_code) || ':main', 'live', e.exchange_id, e.region, 'standard'
FROM sm.exchange e
WHERE e.exchange_code IN ('KALSHI', 'POLYMARKET_US', 'POLYMARKET_INTL');

INSERT INTO account_master.gateway (gateway_key, mode, exchange_id, region, profile)
VALUES ('paper', 'paper', NULL, 'us-east-1', 'paper');

INSERT INTO account_master.gateway_account (account_id, gateway_key, actor)
SELECT a.account_id, g.gateway_key, 'migration'
FROM account_master.venue_account a
JOIN account_master.gateway g ON g.mode = 'live' AND g.exchange_id = a.exchange_id
WHERE a.status <> 'RETIRED';
