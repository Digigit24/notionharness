-- Prompt payload for page-scoped runs. Idempotent for safe restarts.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS prompt TEXT;
