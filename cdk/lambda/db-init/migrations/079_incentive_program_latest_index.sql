-- The open-programs read walks each program's latest version off the lookup index; carrying period_end and the row
-- id there makes that walk index-only, so a page stops after its rows instead of reading every version that still
-- looks open (Polymarket keeps hundreds of thousands, which ran the read past the API's 29 s). Same keys as the
-- lookup index it replaces; nothing reads by the open-period index any more.
-- Built by hand first with CREATE INDEX CONCURRENTLY, so the incentive sync's writes aren't held up; IF NOT EXISTS
-- then only records it. The drops are quick.
CREATE INDEX IF NOT EXISTS idx_incentive_program_latest ON sm.incentive_program
  (exchange_id, venue_program_id, effective_from DESC, recorded_at DESC) INCLUDE (period_end, incentive_program_id);
DROP INDEX IF EXISTS sm.idx_incentive_program_lookup;
DROP INDEX IF EXISTS sm.idx_incentive_program_open;
