-- Code matches on exchange_code, which never changes, so exchange_name is free to be a display label.
ALTER TABLE sm.exchange ADD COLUMN exchange_code varchar;

UPDATE sm.exchange
SET exchange_code = CASE lower(exchange_name)
    WHEN 'polymarket' THEN 'POLYMARKET_INTL'
    ELSE upper(regexp_replace(exchange_name, '[^A-Za-z0-9]+', '_', 'g'))
END;

ALTER TABLE sm.exchange ALTER COLUMN exchange_code SET NOT NULL;
CREATE UNIQUE INDEX idx_exchange_code ON sm.exchange (exchange_code);

UPDATE sm.exchange SET exchange_name = 'Polymarket (International)' WHERE exchange_code = 'POLYMARKET_INTL';
