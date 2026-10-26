-- A stream's record type comes from the gateway that publishes it and is read from stored data, not the registry
-- (Phase 3). Nothing reads this column any more.
ALTER TABLE sm.exchange DROP COLUMN schema_type;
