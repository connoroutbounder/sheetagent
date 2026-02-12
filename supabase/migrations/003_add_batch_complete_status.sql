-- ============================================================
-- 003_add_batch_complete_status.sql — Add batch_complete to run_status enum
-- ============================================================
-- Enables batch processing: when a batch of rows finishes but
-- more rows remain, the run is marked 'batch_complete' so the
-- sidebar can trigger the next batch.

ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'batch_complete';
