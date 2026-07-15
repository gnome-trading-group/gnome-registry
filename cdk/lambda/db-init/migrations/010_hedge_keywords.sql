CREATE TABLE sm.hedge_keyword (
    hedge_keyword_id  SERIAL PRIMARY KEY,
    security_id       INT NOT NULL REFERENCES sm.security(security_id),
    keyword           VARCHAR NOT NULL,
    date_modified     TIMESTAMP NOT NULL DEFAULT NOW(),
    date_created      TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(security_id, keyword)
);
