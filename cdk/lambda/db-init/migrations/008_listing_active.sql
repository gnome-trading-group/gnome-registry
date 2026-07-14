ALTER TABLE sm.listing ADD COLUMN active boolean NOT NULL DEFAULT true;
CREATE INDEX idx_listing_active ON sm.listing (active);
