-- Each event belongs to exactly one native exchange event, so sm.exchange_event folds into sm.event.
-- Titles are no longer canonicalized, so the exchange's raw title becomes the event title.
-- Events still merged across several native events are left NULL here; they are deleted before
-- the follow-up migration makes these columns NOT NULL and drops sm.exchange_event.
ALTER TABLE sm.event ADD COLUMN exchange_id integer REFERENCES sm.exchange(exchange_id);
ALTER TABLE sm.event ADD COLUMN native_event_id varchar;
ALTER TABLE sm.event ADD COLUMN native_url varchar;

UPDATE sm.event e
SET exchange_id = xe.exchange_id,
    native_event_id = xe.native_event_id,
    title = xe.raw_title,
    native_url = xe.native_url
FROM sm.exchange_event xe
WHERE xe.event_id = e.event_id
  AND (SELECT count(*) FROM sm.exchange_event x2 WHERE x2.event_id = e.event_id) = 1;

CREATE UNIQUE INDEX idx_event_native ON sm.event (exchange_id, native_event_id);
