-- Per-message runtime settings.
--
-- An agent carries defaults (`agents.runtime_config`), but the useful control
-- is per message: "answer this one with more effort", "let this one edit
-- without asking". Storing the override on the run keeps it with the turn it
-- belongs to, so a transcript can later say what settings produced a given
-- answer, rather than only what the agent's defaults happen to be now.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_config JSONB;
