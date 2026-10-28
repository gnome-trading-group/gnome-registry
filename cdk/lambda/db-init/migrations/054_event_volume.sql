-- An event's traded notional over the last 24 hours, about USD, as the classifier last saw it on the venue (summed over
-- the event's contracts; Polymarket US gives only a volume bucket's floor). Market-data collection rules select events
-- by it. NULL until the classifier first writes it.
ALTER TABLE sm.event ADD COLUMN volume_24h double precision;
ALTER TABLE sm.event ADD COLUMN volume_updated_at timestamp;

-- Collection rules ask for an exchange's open events by volume, largest first.
CREATE INDEX idx_event_volume ON sm.event (exchange_id, volume_24h DESC NULLS LAST) WHERE NOT resolved;
