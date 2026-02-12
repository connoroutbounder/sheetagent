-- ============================================================
-- 002_add_written_to_sheet.sql — Track which rows have been written to the sheet
-- ============================================================
-- The sidebar now handles writing results to the sheet via Apps Script.
-- This column tracks which results have been relayed back to the sheet.

ALTER TABLE run_rows ADD COLUMN IF NOT EXISTS written_to_sheet BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_run_rows_pending_writes 
  ON run_rows(run_id, written_to_sheet) 
  WHERE status = 'complete' AND written_to_sheet = FALSE;
