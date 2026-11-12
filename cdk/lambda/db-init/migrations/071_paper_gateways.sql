-- Paper order gateways: one per venue, like live ones, keyed paper:<exchange code, lower case>:<instance>, in the
-- venue's region, each simulating its venue for the paper sessions that trade it. None is seeded: a paper gateway's
-- row is created the first time a paper session wants it (gateways PATCH with wanted), so a new exchange gets one the
-- first time it is paper-traded and never before. The one simulated gateway for every venue this table started with
-- was never run.
DELETE FROM account_master.gateway WHERE gateway_key = 'paper';

ALTER TABLE account_master.gateway DROP CONSTRAINT gateway_gateway_key_check;
ALTER TABLE account_master.gateway
    ADD CONSTRAINT gateway_gateway_key_check CHECK (gateway_key ~ '^(paper|live):[a-z0-9_]+:[a-z0-9-]+$');

-- Every gateway trades one venue now, and its key says which kind it is.
ALTER TABLE account_master.gateway DROP CONSTRAINT gateway_check;
ALTER TABLE account_master.gateway
    ADD CONSTRAINT gateway_check CHECK (exchange_id IS NOT NULL AND (
        (mode = 'paper' AND profile = 'paper' AND gateway_key LIKE 'paper:%')
        OR (mode = 'live' AND profile IN ('standard', 'low_latency') AND gateway_key LIKE 'live:%')));
