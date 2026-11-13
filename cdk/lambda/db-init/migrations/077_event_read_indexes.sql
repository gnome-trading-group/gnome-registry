-- Readers ask for a start-time window whether or not the events are resolved (the launcher's game scanner keeps a
-- resolved game in view to shut its session down), so the start time index covers both.
DROP INDEX sm.idx_event_start_time;
CREATE INDEX idx_event_start_time ON sm.event (start_time) WHERE start_time IS NOT NULL;

-- The controller lists events newest first, with or without resolved ones, paging by offset: these give that order
-- (event_id breaks ties, bulk inserts share a date_created) without sorting the whole table.
DROP INDEX sm.idx_event_resolved;
CREATE INDEX idx_event_resolved_created ON sm.event (resolved, date_created, event_id);
CREATE INDEX idx_event_created ON sm.event (date_created, event_id);

-- Event search matches titles by substring.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_event_title_trgm ON sm.event USING GIN (title gin_trgm_ops);
