-- R14-P0.4 — file attachments on a channel message.
--
-- A JSONB array of MEDIA IDS, not a duplicate blob and not a Payload
-- relationship. `team_messages` is a raw-pg broker table (AGENTS.md D5: the
-- broker and Payload never share a migration runner), so there is no
-- `relationTo` to point at `media` from here — the same reason `run`/`session`
-- on `artifacts` are plain numbers rather than relationships. The Media
-- collection itself owns the workspace check; this column only remembers
-- WHICH files a message carries.
--
-- Defaulted to '[]'::jsonb rather than nullable, matching `mentions` on the
-- same table (migration 0013): every reader can assume an array and never
-- has to branch on NULL.
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Not GIN-indexed like `mentions`: mentions are looked up BY VALUE ("every
-- message mentioning me", `listUserMentions`'s `@>` query), attachments never
-- are — the only read is "this message's own array", already keyed by the
-- message's own primary key.
