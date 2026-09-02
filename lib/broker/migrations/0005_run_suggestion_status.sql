-- ROADMAP B3.1 (Batch B-2 "Moat", suggestions mode) — whole-run accept/reject
-- state for a run's page subtree. Meaningful only once page_subtree_block_id
-- is set (see 0002_run_page_context.sql); defaults to 'pending' so every run
-- that ever gets a subtree starts out needing review, and stays 'pending'
-- forever for runs that never write to a page (the column is simply unread
-- in that case). Idempotent for safe restarts, same pattern as every other
-- migration in this directory.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS suggestion_status TEXT NOT NULL DEFAULT 'pending';
