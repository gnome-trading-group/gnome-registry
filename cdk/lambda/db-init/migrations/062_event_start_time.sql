-- An event's scheduled start as its venue lists it now (Kalshi's milestone, Polymarket's game start time,
-- Hyperliquid's scheduled start), as the classifier last read it; NULL when the venue gives none. Venues move a game
-- when it is rescheduled while its ticker and rules keep the original time, so this is the only current one.
ALTER TABLE sm.event ADD COLUMN start_time timestamp;
-- When start_time last changed.
ALTER TABLE sm.event ADD COLUMN start_time_updated_at timestamp;

CREATE INDEX idx_event_start_time ON sm.event (start_time) WHERE NOT resolved AND start_time IS NOT NULL;

-- Every start time the classifier wrote for an event, appended when it changes: what the schedule was at any moment,
-- for research that must not see a reschedule before it was announced.
CREATE TABLE sm.event_schedule_change (
    schedule_change_id bigserial PRIMARY KEY,
    event_id           integer   NOT NULL REFERENCES sm.event (event_id) ON DELETE CASCADE,
    start_time         timestamp,
    -- Where the venue gives it: kalshi-milestone, polymarket-game-start, hyperliquid-scheduled-start.
    source             text,
    observed_at        timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_event_schedule_change_event ON sm.event_schedule_change (event_id, observed_at);
