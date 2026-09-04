-- A run can answer a channel message.
--
-- Mentioning an agent in a channel stored a mention index and did nothing
-- else: no run, no reply, no work assigned to the agent that was named. The
-- index made "who was mentioned" queryable and never made it ACT. This column
-- is the missing link -- it lets a settled run find the message it was answering
-- so its reply can land in that message's thread rather than nowhere.
--
-- A column on `runs` rather than a join table, matching how task_id, page_id
-- and session_id already work: a run answers at most one thing, and the
-- existing shape says so.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS channel_message_id BIGINT;

-- The settle path asks "does this run owe a channel a reply", which is a
-- lookup by run id and needs no index. This one serves the opposite question --
-- "has this message already been answered" -- which is what stops a retried or
-- duplicated dispatch posting the same reply twice.
CREATE INDEX IF NOT EXISTS runs_channel_message_idx ON runs (channel_message_id)
  WHERE channel_message_id IS NOT NULL;
