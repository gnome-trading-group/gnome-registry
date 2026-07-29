CREATE INDEX IF NOT EXISTS idx_security_asset_class ON sm.security(asset_class);
CREATE INDEX IF NOT EXISTS idx_listing_security_id ON sm.listing(security_id);
CREATE INDEX IF NOT EXISTS idx_event_contract_security_id ON sm.event_contract(security_id);
