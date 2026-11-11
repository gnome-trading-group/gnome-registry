-- The venue partition a listing trades on, where the venue splits an account's cash by partition (a Kalshi exchange
-- shard: its cash only backs orders on its own markets), as the venue names it; the same key as the partitions of
-- treasury.balance_snapshot.cash_by_partition. Null where the venue doesn't partition.
ALTER TABLE sm.listing ADD COLUMN venue_partition TEXT CHECK (venue_partition <> '');

-- Finds the orders a venue recently refused for want of cash, which the monitoring rules check every minute.
CREATE INDEX idx_order_insufficient_funds ON ledger.order (closed_at) WHERE reject_reason = 'INSUFFICIENT_FUNDS';
