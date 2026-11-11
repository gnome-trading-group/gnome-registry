-- A listing's traded notional over the last 24 hours, about USD, as the exchange sync last read it from the venue.
-- Market-data collection rules select listings (perps, spot) by it, as they select events by sm.event.volume_24h.
-- NULL until the sync first writes it, and for listings no sync reads (prediction-market contracts).
ALTER TABLE sm.listing ADD COLUMN volume_24h double precision;
ALTER TABLE sm.listing ADD COLUMN volume_updated_at timestamp;

-- Collection rules ask for an exchange's active listings by volume, largest first.
CREATE INDEX idx_listing_volume ON sm.listing (exchange_id, volume_24h DESC NULLS LAST) WHERE active;
