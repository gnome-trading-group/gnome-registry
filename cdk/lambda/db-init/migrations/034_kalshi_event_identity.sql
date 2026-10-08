-- Kalshi binaries were keyed by their Kalshi event ticker when the event had one market and by the market ticker
-- when it had more, so a market changed identity whenever Kalshi added or removed a sibling market, and its
-- security ended up under two events. The classifier now always keys a binary by its market ticker; this moves the
-- existing rows onto that rule. Run with the classifier's fetch paused and its contracts queue drained, after the
-- open single-market mutually exclusive events have been converted to multi-outcome (they keep the event ticker).
CREATE TEMP TABLE kalshi_binary ON COMMIT DROP AS
SELECT ec.event_contract_id, ec.event_id, ec.security_id, split_part(l.exchange_security_id, ':', 1) AS ticker
FROM sm.event_contract ec
JOIN sm.listing l ON l.security_id = ec.security_id
JOIN sm.security s ON s.security_id = ec.security_id
JOIN sm.exchange x ON x.exchange_id = l.exchange_id
WHERE x.exchange_code = 'KALSHI' AND s.contract_type = 7 AND l.exchange_security_id LIKE '%:%';
CREATE INDEX ON kalshi_binary (security_id);
ANALYZE kalshi_binary;

-- Markets that already flipped are under both events: keep the link to the one keyed by the market ticker.
CREATE TEMP TABLE dropped_event ON COMMIT DROP AS
SELECT DISTINCT b.event_id FROM kalshi_binary b
JOIN sm.event e ON e.event_id = b.event_id
WHERE e.native_event_id <> b.ticker
  AND EXISTS (SELECT 1 FROM kalshi_binary other JOIN sm.event oe ON oe.event_id = other.event_id
              WHERE other.security_id = b.security_id AND oe.native_event_id = other.ticker);

DELETE FROM sm.event_contract ec USING kalshi_binary b, sm.event e
WHERE ec.event_contract_id = b.event_contract_id AND e.event_id = b.event_id AND e.native_event_id <> b.ticker
  AND b.event_id IN (SELECT event_id FROM dropped_event);
DELETE FROM kalshi_binary b WHERE NOT EXISTS (SELECT 1 FROM sm.event_contract ec WHERE ec.event_contract_id = b.event_contract_id);
DELETE FROM sm.event e WHERE e.event_id IN (SELECT event_id FROM dropped_event)
  AND NOT EXISTS (SELECT 1 FROM sm.event_contract ec WHERE ec.event_id = e.event_id);

-- Earlier cleanups removed some flipped markets' contracts but left their events, empty, still holding the market
-- ticker a binary is about to take. They hold nothing, so they go.
DELETE FROM sm.event o USING sm.exchange x
WHERE x.exchange_code = 'KALSHI' AND o.exchange_id = x.exchange_id
  AND o.native_event_id IN (SELECT ticker FROM kalshi_binary)
  AND NOT EXISTS (SELECT 1 FROM sm.event_contract ec WHERE ec.event_id = o.event_id);

-- A binary event holds one market's YES and NO; one spanning several markets can't be keyed by a market ticker.
-- Any other event already holding a binary's market ticker would need a decision about which one to keep.
DO $$
DECLARE
    clash TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM kalshi_binary GROUP BY event_id HAVING count(DISTINCT ticker) > 1) THEN
        RAISE EXCEPTION 'Kalshi binary events spanning more than one market; resolve them before re-keying';
    END IF;
    SELECT string_agg(DISTINCT b.ticker, ', ') INTO clash
    FROM kalshi_binary b
    JOIN sm.event e ON e.event_id = b.event_id
    JOIN sm.event o ON o.exchange_id = e.exchange_id AND o.native_event_id = b.ticker AND o.event_id <> e.event_id
    WHERE e.native_event_id <> b.ticker;
    IF clash IS NOT NULL THEN
        RAISE EXCEPTION 'Market tickers already used by another Kalshi event: %', clash;
    END IF;
END $$;

UPDATE sm.event e SET native_event_id = b.ticker, date_modified = NOW()
FROM (SELECT DISTINCT event_id, ticker FROM kalshi_binary) b
WHERE e.event_id = b.event_id AND e.native_event_id <> b.ticker;
