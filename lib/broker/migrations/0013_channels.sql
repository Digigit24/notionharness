-- Channels: threads, mentions, per-member unread, reactions, human members.
--
-- Deliberately NOT a second messaging system, and deliberately NOT a rename.
-- `teams` ARE channels; the tables keep their names and only the UI says
-- "channel", because a rename buys nothing and costs every query, every type
-- and every comment in the repository.
--
-- THE ONE DECISION THIS FILE MAKES, recorded because retrofitting it later is
-- the expensive kind of change:
--
--   `to_slot_id IS NULL` means BROADCAST, and in a channel most posts are
--   broadcasts. That leaves "a directed note inside a room" and "a channel
--   post" sharing one column, which is fine — but it means a future direct
--   message must be A CHANNEL OF TWO, never a new directed-message concept.
--   A channel of two inherits threads, mentions, reactions, unread, search
--   and the canvas for free; a parallel DM system would have to reimplement
--   every one of them. `to_slot_id` stays what it is: the agent mailbox, for
--   one member telling another member something specific.
--
-- Every statement is additive and idempotent.

-- --------------------------------------------------------------------------
-- Threads. One column, not an entity.
--
-- A separate `threads` table would duplicate `team_messages` and force every
-- reader to union two shapes. Slack's own model is a self-reference, and the
-- main feed is simply "roots only".
ALTER TABLE team_messages
  ADD COLUMN IF NOT EXISTS thread_root_id BIGINT REFERENCES team_messages(id) ON DELETE CASCADE;

-- The main feed's exact query: roots of one channel, in order. A partial index
-- because the feed NEVER wants replies, and excluding them keeps the index the
-- size of the conversation rather than the size of all traffic.
CREATE INDEX IF NOT EXISTS team_messages_feed_roots_idx
  ON team_messages (team_id, id) WHERE thread_root_id IS NULL;

-- A thread pane's exact query.
CREATE INDEX IF NOT EXISTS team_messages_thread_idx
  ON team_messages (thread_root_id, id) WHERE thread_root_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Mentions. Parsed on write; the body text stays canonical.
--
-- Storing the parse means "everything mentioning me" is one indexed lookup
-- rather than a LIKE scan over every message ever written, and it survives a
-- display-name change because it holds ids, not text.
ALTER TABLE team_messages
  ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS team_messages_mentions_idx ON team_messages USING GIN (mentions);

-- --------------------------------------------------------------------------
-- Unread, per member. This one fixes a real bug rather than adding a feature.
--
-- `team_messages.read_at` is a single timestamp ON THE MESSAGE, so it can say
-- "this was read" but never "Alice read it and Bob did not". That is correct
-- for a one-recipient mailbox and simply wrong for a room, where the same
-- message has many readers. A high-water mark per member answers it with one
-- comparison and no join table.
--
-- `read_at` is left alone: it still means what it meant for a directed note.
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS last_read_message_id BIGINT;

-- --------------------------------------------------------------------------
-- Reactions. A table, not a JSONB column on the message.
--
-- Toggling inside JSONB is read-modify-write, and two people reacting at the
-- same instant lose one of the reactions. This project has already been bitten
-- by exactly that shape once, on task claims, which is why `claimTeamTask`
-- guards inside its UPDATE. A row per reaction with a unique index makes the
-- race impossible rather than unlikely.
CREATE TABLE IF NOT EXISTS team_message_reactions (
  id            BIGSERIAL PRIMARY KEY,
  message_id    BIGINT NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  actor_slot_id BIGINT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  emoji         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One reaction per (message, actor, emoji). The unique index IS the toggle:
-- adding is an INSERT ... ON CONFLICT DO NOTHING, removing is a DELETE, and
-- neither can double-count under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS team_message_reactions_unique_idx
  ON team_message_reactions (message_id, actor_slot_id, emoji);

CREATE INDEX IF NOT EXISTS team_message_reactions_message_idx
  ON team_message_reactions (message_id);

-- --------------------------------------------------------------------------
-- Humans as members. The one non-trivial change here.
--
-- Everything downstream already speaks SLOTS rather than agents — tasks are
-- owned by a slot, messages come from a slot, reactions are by a slot — so a
-- slot backed by a person instead of an agent needs no change anywhere except
-- the two places that assumed `agent_id` was always present.
ALTER TABLE team_members ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS user_id INTEGER;

-- Exactly one of the two, enforced by the database rather than by every
-- caller remembering. `num_nonnulls` says it in one expression.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'team_members_agent_xor_user'
  ) THEN
    ALTER TABLE team_members
      ADD CONSTRAINT team_members_agent_xor_user CHECK (num_nonnulls(agent_id, user_id) = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id);

-- A HUMAN MAY HOLD THE LEADER SLOT, and the existing one-leader partial unique
-- index is left exactly as it is.
--
-- What that means, stated because it is a real behavioural difference rather
-- than an oversight: automatic delegation is an agent leader receiving a run
-- and calling the team tools. A human leader has no run, so nothing delegates
-- on its own — the human assigns. That degrades correctly instead of breaking,
-- because R6.3 already made the BOARD authoritative rather than the leader:
-- members claim whatever has its dependencies met, with or without a leader.

-- --------------------------------------------------------------------------
-- Channel-shaped fields on `teams`. Additive; nothing is renamed.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS topic TEXT;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Channel names are shown with a leading '#', so two channels with the same
-- name in one workspace would be indistinguishable to a person reading the
-- list. Case-insensitive, and only among live channels — archiving a channel
-- should free its name.
CREATE UNIQUE INDEX IF NOT EXISTS teams_workspace_name_uidx
  ON teams (workspace_id, lower(name)) WHERE archived_at IS NULL;
