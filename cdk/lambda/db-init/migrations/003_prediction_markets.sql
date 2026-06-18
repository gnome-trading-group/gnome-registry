CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE sm.event (
    event_id          serial       PRIMARY KEY,
    title             varchar      NOT NULL,
    description       text,
    category          varchar,
    resolution_source varchar,
    tags              text[],
    embedding         vector(1024),
    resolved          boolean      NOT NULL DEFAULT false,
    resolved_at       timestamp,
    expiry            timestamp,
    date_modified     timestamp    NOT NULL DEFAULT now(),
    date_created      timestamp    NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_tags ON sm.event USING GIN (tags);
CREATE INDEX idx_event_title ON sm.event (title);

CREATE TABLE sm.event_contract (
    event_contract_id      serial  PRIMARY KEY,
    event_id               integer NOT NULL REFERENCES sm.event(event_id),
    security_id            integer NOT NULL REFERENCES sm.security(security_id),
    outcome_label          varchar NOT NULL,
    complement_security_id integer REFERENCES sm.security(security_id),
    date_created           timestamp NOT NULL DEFAULT now(),
    UNIQUE (event_id, security_id)
);

-- relationship_type values:
--   EQUIVALENT         same event + outcome across exchanges (direct arb; prices should be equal)
--   COMPLEMENT         YES/NO pair within same event (prices should sum to ~$1.00)
--   IMPLIES            directional: security_id_a being true means security_id_b must be true
--                      (e.g., "BTC > 150k" implies "BTC > 140k" — arb if priced wrong)
--   MUTUALLY_EXCLUSIVE both cannot be true simultaneously
--   CORRELATED         statistically related, not logically linked
--   HEDGEABLE_WITH     useful hedge pair, possibly cross-asset-class
CREATE TABLE sm.contract_relationship (
    relationship_id  serial    PRIMARY KEY,
    security_id_a    integer   NOT NULL REFERENCES sm.security(security_id),
    security_id_b    integer   NOT NULL REFERENCES sm.security(security_id),
    relationship_type varchar  NOT NULL,
    confidence        real      NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    method           varchar   NOT NULL,
    reviewed         boolean   NOT NULL DEFAULT false,
    reviewed_at      timestamp,
    date_created     timestamp NOT NULL DEFAULT now(),
    UNIQUE (security_id_a, security_id_b)
);

ALTER TABLE sm.security ADD CONSTRAINT chk_event_contract_requires_expiry
    CHECK (type != 4 OR expiry IS NOT NULL);

CREATE TABLE sm.exchange_event (
    exchange_event_id  serial    PRIMARY KEY,
    exchange_id        integer   NOT NULL REFERENCES sm.exchange(exchange_id),
    event_id           integer   NOT NULL REFERENCES sm.event(event_id),
    native_event_id    varchar   NOT NULL,
    raw_title          varchar   NOT NULL,
    date_created       timestamp NOT NULL DEFAULT now(),
    UNIQUE (exchange_id, native_event_id)
);

CREATE INDEX idx_exchange_event_event_id ON sm.exchange_event (event_id);
