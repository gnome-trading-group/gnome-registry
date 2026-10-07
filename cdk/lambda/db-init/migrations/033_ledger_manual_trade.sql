-- MANUAL: a trade an operator made outside any session (e.g. closing a position by hand on the venue) and booked
-- afterwards. It belongs to no session, so its realized_pnl_after and fees_after hold that trade's own amounts
-- rather than a session's running totals; lifetime PnL adds them to the sum of each session's last totals.
ALTER TABLE ledger.fill DROP CONSTRAINT fill_source_check;
ALTER TABLE ledger.fill ADD CONSTRAINT fill_source_check
    CHECK (source IN ('VENUE', 'RECOVERY', 'RESET', 'ADJUSTMENT', 'MANUAL', 'GAP'));
