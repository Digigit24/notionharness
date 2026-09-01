-- Per-run page write handle. Idempotent for safe daemon/app restarts.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS page_id BIGINT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS page_subtree_block_id TEXT;
