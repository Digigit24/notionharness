-- R6.6 — teams reliability: heartbeats, lost slots, dead letters, idempotency,
-- and a room-wide stop.
--
-- Four independent problems, one migration, because three of them are columns
-- on tables migration 0009 already created and splitting them would only mean
-- three files nobody can apply in isolation anyway.
--
-- Every statement is additive and idempotent, matching every other file here.

-- ---------------------------------------------------------------------------
-- 1. HEARTBEATS PER MEMBER
-- ---------------------------------------------------------------------------
--
-- Deliberately NOT a `team_member_heartbeats` table with its own writer.
--
-- A slot's turn is an ordinary run (R6.1's whole point), and a run already
-- emits a durable, timestamped trail: `run_messages` rows are flushed
-- continuously during the turn (lib/dispatcher/worker.ts batches at 50 events
-- or on a timer, not once at settle), `runs.updated_at` moves on every lease
-- renewal, and the slot's own writes land in `team_messages` and `team_tasks`.
-- A separate heartbeat writer would have to live in the dispatcher, would
-- describe the SAME liveness those rows already describe, and would go stale
-- in exactly the cases the existing rows do not. So the heartbeat is derived
-- (see `lib/teams/reliability.ts`) and only its CONCLUSION is stored here.
--
-- `last_seen_at` is that derived value, materialised by the sweep so the room
-- can still say "last seen 6 minutes ago" after the run rows have been
-- reclaimed (R3.4 removes old worktrees; run history is not forever either).
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
-- Set when the sweep concludes the slot is gone, cleared the moment it speaks
-- again. Nullable rather than a status enum because "lost" is the only
-- abnormal state a slot has, and a two-value enum is a boolean with ceremony.
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS lost_at TIMESTAMPTZ;
-- Why it was declared lost, in the words the room will show. Stored rather
-- than recomputed at render time because the evidence (an active run, a task
-- it held) may be gone by the time anybody looks.
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS lost_reason TEXT;

-- ---------------------------------------------------------------------------
-- 2. DEAD LETTERS — the silent-broadcast bug
-- ---------------------------------------------------------------------------
--
-- `team_messages.to_slot_id` was `ON DELETE SET NULL`. NULL in that column
-- means BROADCAST (0009 chose a nullable column precisely so "everyone" could
-- not be confused with "a slot that was deleted" — and then the FK action went
-- and confused them anyway). The effect was real and silent: remove a slot,
-- and every private instruction ever addressed to it becomes a message the
-- whole team reads on its next `team_read_inbox` poll. Nothing in the code
-- could tell the two apart afterwards, because no evidence survived.
--
-- The fix is to stop discarding the address. Dropping the constraint — rather
-- than adding a tombstone slot, or moving the FK to RESTRICT — is what makes
-- the two cases distinguishable WITHOUT touching a single query:
--
--   * `readTeamInbox`'s broadcast branch is `to_slot_id IS NULL`; a dangling
--     id is not NULL, so an undeliverable message stops being broadcast the
--     instant this constraint is gone.
--   * its directed branch is `to_slot_id = $slot`; ids come from BIGSERIAL and
--     are never reused, so a dangling id can never match a future slot either.
--
-- The cost is a column that can point at a row that no longer exists. That is
-- the correct shape here: `team_messages` is append-only by design ("a message
-- is a fact about what was said"), and who it was addressed to is part of the
-- fact. RESTRICT would have made removing a slot fail, which is worse.
ALTER TABLE team_messages DROP CONSTRAINT IF EXISTS team_messages_to_slot_id_fkey;
-- Same treatment for the sender, same bug one column over: `from_slot_id` SET
-- NULL means a departed member's old messages are attributed to the human, and
-- `components/teams/shared.ts` had to state that as a known lie it could not
-- fix. Keeping the id fixes it for every row written from now on. Rows already
-- NULLed by past deletions are unrecoverable — the id was destroyed.
ALTER TABLE team_messages DROP CONSTRAINT IF EXISTS team_messages_from_slot_id_fkey;

-- The dead-letter marks themselves. `undeliverable_at` is what the UI reads to
-- strike a message through; the reason is written once, at the moment the
-- evidence exists.
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS undeliverable_at TIMESTAMPTZ;
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS undeliverable_reason TEXT;

-- Rows the ROOM wrote, not a person and not a slot.
--
-- Before this, `from_slot_id IS NULL` meant "the human typed it" and the feed
-- labelled it "You". The sweep needs to say things in the channel ("Reviewer
-- went silent; task 12 is back on the board") and those must not be printed
-- under a human's name. NULL + a non-null `system_kind` is the third case.
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS system_kind TEXT;

-- Undeliverable mail is a small set that the room asks for by itself.
CREATE INDEX IF NOT EXISTS team_messages_dead_letter_idx
  ON team_messages (team_id, id) WHERE undeliverable_at IS NOT NULL;

-- Stamping happens in a TRIGGER, not in the server action that removes a slot,
-- because a slot can leave four ways: the roster's remove button, a cascade
-- from `DELETE FROM teams`, a future MCP tool, and somebody at a psql prompt.
-- A dead letter that depends on which door was used is not a dead letter.
--
-- BEFORE DELETE is required, not stylistic: it is the last moment at which
-- `team_messages.to_slot_id` still points at this slot.
CREATE OR REPLACE FUNCTION team_members_dead_letter() RETURNS trigger AS $$
DECLARE
  affected INTEGER;
BEGIN
  -- NOT filtered on `read_at`, and that is the whole correctness of this
  -- statement.
  --
  -- `team_messages.read_at` is ONE column for the whole installation, and the
  -- only thing that ever sets it is the human room view: `markRoomReadAction`
  -- stamps every id in the poll delta, including messages directed at a slot.
  -- The addressee itself never touches it — `readTeamInbox` is a pure SELECT.
  -- So `read_at IS NOT NULL` means "a person had the room open", which says
  -- exactly nothing about whether the SLOT received anything.
  --
  -- Filtering on it made the dead letter depend on whether somebody happened
  -- to be watching: with the room open, the common case, a removed member's
  -- directed mail was stamped with nothing, announced as nothing, and absent
  -- from the dead-letter queue — while still being undeliverable. That is the
  -- same silent-loss class as the broadcast bug above, and it is the arbitrary
  -- "which door was used" dependency this trigger exists to rule out.
  --
  -- Nothing in the schema records what a slot actually consumed, so the honest
  -- predicate is the one that can be evaluated: it was addressed to a slot,
  -- and that slot is going away. Over-reporting is visible and explainable;
  -- under-reporting is the bug.
  UPDATE team_messages
     SET undeliverable_at = now(),
         undeliverable_reason = 'Addressed to "' || OLD.display_name || '" (slot ' || OLD.id ||
                                '), which was removed from the team before this could be acted on.'
   WHERE to_slot_id = OLD.id
     AND undeliverable_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;

  -- Announce it in the room, once, with a count — not once per message.
  --
  -- The `teams` EXISTS check is what keeps a whole-team delete quiet: when
  -- `DELETE FROM teams` cascades into `team_members`, the parent row is
  -- already gone by the time this fires, so the announcement is skipped. There
  -- is no room left to announce it to, and the messages are about to cascade
  -- away themselves.
  IF affected > 0 AND EXISTS (SELECT 1 FROM teams WHERE id = OLD.team_id) THEN
    INSERT INTO team_messages (team_id, from_slot_id, to_slot_id, kind, body, system_kind)
    VALUES (
      OLD.team_id,
      NULL,
      NULL,
      'status',
      affected || ' message' || CASE WHEN affected = 1 THEN '' ELSE 's' END ||
        ' addressed to "' || OLD.display_name || '" could not be delivered: the slot was removed. ' ||
        'They are dead letters, not broadcasts — nobody else received them.',
      'dead_letter'
    );
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS team_members_dead_letter_trg ON team_members;
CREATE TRIGGER team_members_dead_letter_trg
  BEFORE DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_members_dead_letter();

-- ---------------------------------------------------------------------------
-- 3. IDEMPOTENCY, BY TASK AND SLOT
-- ---------------------------------------------------------------------------
--
-- An agent retries. It retries on a timeout it cannot distinguish from a
-- failure, on a transport error after the write committed, and because a model
-- decided to. Today a retried `team_report_done` is refused with an error the
-- first call never produced, and a retried `team_claim_task` is told somebody
-- else took it — when "somebody else" is itself.
--
-- Keyed by (slot, tool, task, fingerprint) as R6.6 asks. The fingerprint is a
-- hash of the semantic arguments so that a genuinely DIFFERENT call is never
-- swallowed by an earlier one's record — "report done with summary A" and
-- "report done with summary B" must not collide, or idempotency becomes data
-- loss.
--
-- `slot_id` carries no foreign key ON PURPOSE: the record of what a slot
-- already did has to outlive the slot, or removing a member would make every
-- one of its calls retryable again.
CREATE TABLE IF NOT EXISTS team_tool_calls (
  id           BIGSERIAL PRIMARY KEY,
  team_id      BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slot_id      BIGINT NOT NULL,
  tool         TEXT NOT NULL,
  task_id      BIGINT,
  fingerprint  TEXT NOT NULL,
  -- Two phases, so a duplicate arriving WHILE the first is still running is
  -- refused rather than executed. A one-phase "insert the result afterwards"
  -- record only dedupes calls that arrive after the first one finished, which
  -- is the easy half.
  status       TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'done')),
  -- The exact string the first call returned, replayed verbatim to a retry.
  -- Anything else — "already done", a fresh re-read — would be a different
  -- answer to the same question, which is what idempotency is meant to rule out.
  result       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- COALESCE rather than plain (slot_id, tool, task_id, fingerprint): NULLs are
-- distinct in a unique index, so two task-less calls with the same fingerprint
-- would both insert and neither would dedupe. `-1` is safe as the sentinel
-- because `team_tasks.id` is BIGSERIAL and never negative.
CREATE UNIQUE INDEX IF NOT EXISTS team_tool_calls_key_uidx
  ON team_tool_calls (slot_id, tool, COALESCE(task_id, -1), fingerprint);
-- The room's "what have the agents actually done" read, newest first.
CREATE INDEX IF NOT EXISTS team_tool_calls_team_idx ON team_tool_calls (team_id, id DESC);

-- ---------------------------------------------------------------------------
-- 4. ROOM-WIDE STOP
-- ---------------------------------------------------------------------------
--
-- The stop itself reuses `runs.cancel_requested_at` and `requestRunCancellation`
-- (migration 0010) — there is deliberately no second cancellation path. These
-- two columns record only that a HUMAN asked the whole room to stop, which the
-- per-run columns cannot express: after the last turn settles, every
-- `cancel_requested_at` is wiped along with the run's other live state, and the
-- room would have no memory of having been stopped.
--
-- The sweep in `lib/teams/reliability.ts` reads this for a second reason: after
-- a deliberate stop, silence is EXPECTED, and marking a slot lost for going
-- quiet when a person just told it to would be the watchdog reporting its own
-- instruction back as a fault.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS stop_requested_by INTEGER;
