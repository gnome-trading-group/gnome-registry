-- Market-data sources and streams. A source is where data comes from: a trading venue (one per sm.exchange) or a data
-- vendor. A stream is one thing collected from a source: a listing's book, or a vendor subject such as one esports
-- match. Collection, storage and delivery to strategies are keyed by stream; trading stays keyed by listing.
CREATE SCHEMA md;

-- A venue collects where it trades, so its region is sm.exchange.region and it carries none of its own; a vendor has
-- no exchange row and names its region here. code is immutable: shards and secrets are named after it.
CREATE TABLE md.source (
    source_id     SERIAL      PRIMARY KEY,
    code          VARCHAR     NOT NULL UNIQUE,
    kind          VARCHAR(6)  NOT NULL CHECK (kind IN ('VENUE', 'VENDOR')),
    exchange_id   INTEGER     UNIQUE REFERENCES sm.exchange (exchange_id) ON DELETE CASCADE,
    home_region   VARCHAR,
    adapter       VARCHAR     NOT NULL,
    families      VARCHAR[]   NOT NULL,
    active        BOOLEAN     NOT NULL DEFAULT TRUE,
    date_created  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    date_modified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((kind = 'VENUE' AND exchange_id IS NOT NULL AND home_region IS NULL)
        OR (kind = 'VENDOR' AND exchange_id IS NULL AND home_region IS NOT NULL))
);

-- stream_id doubles as the Aeron stream id, so it stays within int32. A listing's stream holds only listing_id: its
-- venue key, lifetime and active flag are the listing's, and copies of them would drift. Other subjects carry their
-- own. region overrides the source's region for the rare subject served from somewhere else.
CREATE TABLE md.stream (
    stream_id         SERIAL      PRIMARY KEY,
    source_id         INTEGER     NOT NULL REFERENCES md.source (source_id) ON DELETE CASCADE,
    subject_kind      VARCHAR     NOT NULL,
    listing_id        INTEGER     UNIQUE REFERENCES sm.listing (listing_id) ON DELETE CASCADE,
    native_subject_id VARCHAR,
    family            VARCHAR     NOT NULL,
    region            VARCHAR,
    event_id          INTEGER     REFERENCES sm.event (event_id),
    starts_at         TIMESTAMPTZ,
    ends_at           TIMESTAMPTZ,
    active            BOOLEAN,
    date_created      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((subject_kind = 'LISTING' AND listing_id IS NOT NULL AND native_subject_id IS NULL AND event_id IS NULL
            AND starts_at IS NULL AND ends_at IS NULL AND active IS NULL)
        OR (subject_kind <> 'LISTING' AND listing_id IS NULL AND native_subject_id IS NOT NULL AND active IS NOT NULL))
);

CREATE UNIQUE INDEX idx_stream_subject ON md.stream (source_id, native_subject_id, family)
    WHERE native_subject_id IS NOT NULL;
CREATE INDEX idx_stream_source ON md.stream (source_id);
CREATE INDEX idx_stream_event ON md.stream (event_id) WHERE event_id IS NOT NULL;

-- Exchanges and listings are created by the API, the classifier, the venue sync Lambdas and tests. Creating their
-- source and stream here, inside the inserting transaction, keeps "every listing has its book stream" true on every
-- one of those paths without any of them knowing about streams.
CREATE OR REPLACE FUNCTION md.create_venue_source() RETURNS trigger AS $$
BEGIN
    INSERT INTO md.source (code, kind, exchange_id, adapter, families)
    VALUES (NEW.exchange_code, 'VENUE', NEW.exchange_id, NEW.exchange_code, ARRAY['book']);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_exchange_source
    AFTER INSERT ON sm.exchange
    FOR EACH ROW EXECUTE FUNCTION md.create_venue_source();

CREATE OR REPLACE FUNCTION md.create_listing_stream() RETURNS trigger AS $$
BEGIN
    INSERT INTO md.stream (source_id, subject_kind, listing_id, family)
    SELECT s.source_id, 'LISTING', NEW.listing_id, 'book'
    FROM md.source s
    WHERE s.exchange_id = NEW.exchange_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No market-data source for exchange %', NEW.exchange_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_listing_stream
    AFTER INSERT ON sm.listing
    FOR EACH ROW EXECUTE FUNCTION md.create_listing_stream();

INSERT INTO md.source (code, kind, exchange_id, adapter, families)
SELECT exchange_code, 'VENUE', exchange_id, exchange_code, ARRAY['book']
FROM sm.exchange;

INSERT INTO md.stream (source_id, subject_kind, listing_id, family)
SELECT s.source_id, 'LISTING', l.listing_id, 'book'
FROM sm.listing l
JOIN md.source s ON s.exchange_id = l.exchange_id;
