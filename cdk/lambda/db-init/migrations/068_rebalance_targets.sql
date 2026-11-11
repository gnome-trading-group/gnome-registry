-- Automatic rebalancing of an account's cash between venue partitions (Kalshi's target balance allocation across
-- exchange shards), which the venue poller keeps the venue set to.
--   partition_targets      wanted: percent of sweepable cash per partition, summing to 100, {} to turn rebalancing
--                          off; null leaves whatever the venue has alone
--   rebalance_reservation  what a rebalance leaves behind for resting orders: none, max (the largest single
--                          commitment) or sum (every resting order's margin)
ALTER TABLE treasury.account_config
    ADD COLUMN partition_targets     JSONB,
    ADD COLUMN rebalance_reservation VARCHAR(4) NOT NULL DEFAULT 'sum' CHECK (rebalance_reservation IN ('none', 'max', 'sum'));

-- What the reading found the venue set to: {"allocations": {"0": 80, "3": 20}, "restingMarginReservation": "sum"},
-- plus "error" when it couldn't be read or set. Null where the venue doesn't rebalance.
ALTER TABLE treasury.balance_snapshot ADD COLUMN rebalance_targets JSONB;
