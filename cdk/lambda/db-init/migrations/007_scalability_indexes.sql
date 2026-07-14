CREATE INDEX idx_security_active ON sm.security (active);
CREATE INDEX idx_event_resolved ON sm.event (resolved);
CREATE INDEX idx_contract_relationship_security_id_b ON sm.contract_relationship (security_id_b);
