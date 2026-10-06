-- A strategy's hand-set status (inactive/active/paused) was enforced nowhere, so a "paused" strategy still launched
-- and traded. Whether it's running or halted comes from its sessions and kill switch; archiving only hides a
-- strategy from day-to-day lists and has no effect on trading.
ALTER TABLE strategy.strategy ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE strategy.strategy DROP COLUMN IF EXISTS status;
