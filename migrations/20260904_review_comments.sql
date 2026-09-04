-- R5.3 — line-anchored review comments, batched into one prompt.
--
-- Raw-pg (broker-owned) rather than a Payload collection, matching where
-- `runs` and `chat_sessions` already live and for the reason AGENTS.md D5
-- draws that line: these rows are written from a diff viewer at review speed,
-- keyed on a run, and are never edited in the admin UI. A Payload collection
-- would also have dragged in the whole `payload_locked_documents_rels` /
-- `payload_preferences_rels` ceremony (see 20260904_plugins.sql for what that
-- costs) for state no admin screen will ever show.
--
-- Lives in migrations/ and is applied with `npx tsx scripts/apply-sql.ts`
-- rather than being appended to lib/broker/migrations/apply.ts, because that
-- runner is shared and was off-limits to the unit that wrote this. Applying
-- it twice is a no-op; every statement below is additive and idempotent.
CREATE TABLE IF NOT EXISTS review_comments (
  id           BIGSERIAL PRIMARY KEY,
  -- The run being reviewed. CASCADE because a comment on a deleted run is
  -- meaningless — run retention (lib/run-worktrees/retention.ts) prunes old
  -- runs and these must go with them rather than pile up as orphans.
  run_id       BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,
  -- Which column of the side-by-side view the comment is pinned to. 'old' is
  -- a deleted/context line in the base file, 'new' a line as the run left it.
  -- Stored rather than inferred: "you removed this" and "this line you added
  -- is wrong" are different remarks about the same screen row, and the prompt
  -- has to be able to say which.
  side         TEXT NOT NULL CHECK (side IN ('old', 'new')),
  line_number  INTEGER NOT NULL,
  body         TEXT NOT NULL,
  -- The source line as it read when the comment was written. Denormalised on
  -- purpose: a line NUMBER is only meaningful against one revision of a file,
  -- and the whole point of this table is to survive into a follow-up run that
  -- has already rewritten the file. Quoting the text in the prompt is what
  -- makes the anchor still resolvable after the agent edits around it.
  line_content TEXT,
  author_user_id INTEGER,
  -- 'open' until batched into a prompt, then 'sent'. Sent comments are kept,
  -- not deleted: R5.3's point is that you can check the revision against what
  -- you actually asked for, which requires the asks to still be on screen.
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent')),
  -- The follow-up run that carried this comment. SET NULL, not CASCADE: if
  -- that run is later pruned the comment is still a true record of a remark
  -- that was made, and deleting it would rewrite review history.
  sent_run_id  BIGINT REFERENCES runs(id) ON DELETE SET NULL,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read is "all comments for this run", ordered for display. The index
-- carries the ordering columns so the review page's single load is an index
-- scan rather than a sort.
CREATE INDEX IF NOT EXISTS review_comments_run_idx
  ON review_comments (run_id, file_path, line_number, id);
