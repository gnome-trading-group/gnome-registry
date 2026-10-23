-- Who recorded a mark: a running session's OMS, or the mark poller pricing a listing still held after every session on
-- it has stopped (a contract held to settlement). The poller also writes a row every few minutes on a quiet book, so a
-- held listing never looks unpriced while it is being watched.
ALTER TABLE ledger.mark ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'SESSION';
ALTER TABLE ledger.mark DROP CONSTRAINT IF EXISTS ledger_mark_source_check;
ALTER TABLE ledger.mark ADD CONSTRAINT ledger_mark_source_check CHECK (source IN ('SESSION', 'POLLER'));
