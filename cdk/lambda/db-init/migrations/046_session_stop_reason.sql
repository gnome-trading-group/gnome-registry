-- Why a session stopped and who stopped it: a person, a launcher rule, or the strategy itself. failure_reason stays
-- for sessions that failed.
ALTER TABLE strategy.session ADD COLUMN IF NOT EXISTS stop_reason TEXT;
ALTER TABLE strategy.session ADD COLUMN IF NOT EXISTS stopped_by VARCHAR(200);
