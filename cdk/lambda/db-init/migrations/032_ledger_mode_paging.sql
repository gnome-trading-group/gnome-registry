-- The controller's fills and orders pages list every strategy in a mode, newest first.
CREATE INDEX idx_fill_mode_id ON ledger.fill (mode, fill_id);
CREATE INDEX idx_order_mode_seq ON ledger.order (mode, order_seq);
