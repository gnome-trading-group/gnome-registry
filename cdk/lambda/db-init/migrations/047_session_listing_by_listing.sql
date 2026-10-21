-- The listing and event pages look up the sessions that traded a listing; the primary key leads with session_id.
CREATE INDEX IF NOT EXISTS idx_session_listing_listing ON strategy.session_listing (listing_id);
