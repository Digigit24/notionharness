-- R6.1 — teams: a room where agents work together.
--
-- These live in the broker (raw pg) rather than in Payload, matching where
-- `runs`, `run_messages` and `chat_sessions` already live, and for the same
-- reason: this is high-frequency operational state written by the dispatcher
-- on the hot path, not content a person edits in an admin UI. AGENTS.md D5
-- draws that line and it is drawn here too.
--
-- Every statement is additive and idempotent.

CREATE TABLE IF NOT EXISTS teams (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  INTEGER NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  -- Shared: every member works in one checkout and sees each other's edits
  -- immediately, which is fast and lets them collide. Per-member: each gets
  -- its own worktree and nobody can break anyone else, at the cost of a merge
  -- at the end. Neither is right in general, so it is a choice per team.
  workspace_mode TEXT NOT NULL DEFAULT 'per_member'
    CHECK (workspace_mode IN ('shared', 'per_member')),
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS teams_workspace_idx ON teams (workspace_id);

-- A SLOT, not an agent. The distinction matters: the same agent may be added
-- twice with two different jobs and two different threads, and a slot keeps
-- its identity, its history and its worktree even if the agent behind it is
-- swapped out.
CREATE TABLE IF NOT EXISTS team_members (
  id           BIGSERIAL PRIMARY KEY,
  team_id      BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id     INTEGER NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('leader', 'member')),
  display_name TEXT NOT NULL,
  colour       TEXT,
  -- Each slot gets its own conversation, so a member's thread is a real
  -- `chat_sessions` row like any other and every existing transcript,
  -- streaming and resume mechanism applies to it unchanged.
  session_id   BIGINT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  worktree_id  BIGINT REFERENCES worktrees(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_members_team_idx ON team_members (team_id);
CREATE INDEX IF NOT EXISTS team_members_session_idx ON team_members (session_id);

-- At most one leader per team, enforced by the database rather than by every
-- caller remembering. A partial unique index is the right shape: it constrains
-- only the rows where role = 'leader' and leaves members unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS team_members_one_leader_uidx
  ON team_members (team_id) WHERE role = 'leader';

-- The mailbox. Append-only: a message is a fact about what was said, and
-- editing history would make "who was told what, when" unanswerable.
CREATE TABLE IF NOT EXISTS team_messages (
  id           BIGSERIAL PRIMARY KEY,
  team_id      BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_slot_id BIGINT REFERENCES team_members(id) ON DELETE SET NULL,
  -- NULL means broadcast. A nullable column rather than a magic slot id, so
  -- "to everyone" cannot be confused with "to a slot that was deleted".
  to_slot_id   BIGINT REFERENCES team_members(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'status'
    CHECK (kind IN ('instruction', 'report', 'question', 'answer', 'status')),
  body         TEXT NOT NULL,
  task_id      BIGINT,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The inbox query is "everything for this slot since a cursor", so the index
-- matches it exactly rather than being one column per WHERE clause.
CREATE INDEX IF NOT EXISTS team_messages_inbox_idx ON team_messages (team_id, to_slot_id, id);
CREATE INDEX IF NOT EXISTS team_messages_feed_idx ON team_messages (team_id, id);

CREATE TABLE IF NOT EXISTS team_tasks (
  id           BIGSERIAL PRIMARY KEY,
  team_id      BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  description  TEXT,
  owner_slot_id BIGINT REFERENCES team_members(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled')),
  -- What this task produced, written by `team_report_done` alongside settling
  -- it, so a finished task carries its own answer rather than pointing at a
  -- transcript someone has to go read.
  result       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_tasks_team_idx ON team_tasks (team_id, status);
CREATE INDEX IF NOT EXISTS team_tasks_owner_idx ON team_tasks (owner_slot_id);

-- A real dependency graph, not a queue. An edge table rather than an array
-- column so "who is stuck on whom" is one join in either direction, and so a
-- dependency cannot name a task that does not exist.
CREATE TABLE IF NOT EXISTS team_task_deps (
  task_id    BIGINT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
  blocked_by BIGINT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, blocked_by),
  -- A task blocking itself is never meaningful and would make the
  -- claimability query non-terminating in the obvious recursive form.
  CONSTRAINT team_task_deps_no_self CHECK (task_id <> blocked_by)
);

CREATE INDEX IF NOT EXISTS team_task_deps_blocked_by_idx ON team_task_deps (blocked_by);
