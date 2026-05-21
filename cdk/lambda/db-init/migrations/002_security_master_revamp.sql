-- Clear exchange-sourced data; sync lambda will repopulate from scratch
DROP TABLE sm.listing_spec;
TRUNCATE sm.listing, sm.security RESTART IDENTITY CASCADE;

CREATE TABLE sm.currency (
    currency_id   serial    PRIMARY KEY,
    symbol        VARCHAR   NOT NULL UNIQUE,
    name          VARCHAR,
    decimals      smallint  NOT NULL DEFAULT 8,
    date_modified timestamp NOT NULL DEFAULT now(),
    date_created  timestamp NOT NULL DEFAULT now()
);

ALTER TABLE sm.security ADD COLUMN base_currency_id       integer  REFERENCES sm.currency(currency_id);
ALTER TABLE sm.security ADD COLUMN quote_currency_id      integer  REFERENCES sm.currency(currency_id);
ALTER TABLE sm.security ADD COLUMN settle_currency_id     integer  REFERENCES sm.currency(currency_id);
ALTER TABLE sm.security ADD COLUMN contract_type          smallint NOT NULL DEFAULT 0;
ALTER TABLE sm.security ADD COLUMN inverse                boolean  NOT NULL DEFAULT false;
ALTER TABLE sm.security ADD COLUMN is_quanto              boolean  NOT NULL DEFAULT false;
ALTER TABLE sm.security ADD COLUMN expiry                 timestamp;
ALTER TABLE sm.security ADD COLUMN strike_price           bigint;
ALTER TABLE sm.security ADD COLUMN active                 boolean  NOT NULL DEFAULT true;
ALTER TABLE sm.security ADD COLUMN underlying_security_id integer  REFERENCES sm.security(security_id);
ALTER TABLE sm.security ADD COLUMN asset_class            smallint NOT NULL DEFAULT 0;

-- Rebuild listing_spec as an append-only versioned table
CREATE TABLE sm.listing_spec (
    id                  bigserial PRIMARY KEY,
    listing_id          integer   NOT NULL REFERENCES sm.listing(listing_id),
    tick_size           bigint    NOT NULL,
    lot_size            bigint    NOT NULL,
    min_notional        bigint    NOT NULL DEFAULT 0,
    contract_multiplier bigint    NOT NULL DEFAULT 1000000000,
    recorded_at         timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_listing_spec_lookup
    ON sm.listing_spec (listing_id, recorded_at DESC);

ALTER TABLE sm.security ADD CONSTRAINT chk_option_requires_strike
    CHECK (type != 3 OR strike_price IS NOT NULL);
ALTER TABLE sm.security ADD CONSTRAINT chk_option_requires_expiry
    CHECK (type != 3 OR expiry IS NOT NULL);
ALTER TABLE sm.security ADD CONSTRAINT chk_spot_no_expiry
    CHECK (type != 0 OR expiry IS NULL);
ALTER TABLE sm.security ADD CONSTRAINT chk_spot_no_strike
    CHECK (type != 0 OR strike_price IS NULL);

ALTER TABLE sm.security ADD CONSTRAINT uq_security_symbol UNIQUE (symbol);
ALTER TABLE sm.listing ADD CONSTRAINT uq_listing_exchange_security
    UNIQUE (exchange_id, exchange_security_id);
