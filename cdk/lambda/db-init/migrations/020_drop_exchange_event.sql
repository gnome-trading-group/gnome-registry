-- Every event now carries its native exchange event (019), and the merged events that had
-- several native events have been cleaned up, so sm.exchange_event is redundant.
ALTER TABLE sm.event ALTER COLUMN exchange_id SET NOT NULL;
ALTER TABLE sm.event ALTER COLUMN native_event_id SET NOT NULL;

DROP TABLE sm.exchange_event;
