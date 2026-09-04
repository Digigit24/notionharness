-- Sessions and worktrees: the two durable records this app was faking.
--
-- NAMING, deliberately not `sessions`: this database is Supabase-backed and
-- already has an `auth.sessions` table (GoTrue's own, with `factor_id`,
-- `aal`, `refresh_token_hmac_key` …). An unqualified `sessions` in this app's
-- raw-pg queries would resolve by `search_path`, so a single mis-set
-- search_path could read — or write — the authentication table instead of the
-- chat one. `chat_sessions` cannot collide with anything.
--
-- SESSIONS. Until now a "conversation" was an emergent grouping over `runs`
-- keyed by agent: `listRunsForAgentStandalone` selects every run with
-- `task_id IS NULL AND page_id IS NULL` for an agent, so one agent had
-- exactly one forever-thread and there was no way to start a second one.
-- Continuity was faked by replaying prior turns' text into the next prompt
-- (`enqueueAskRun`), which is why a four-message chat was observed sending a
-- 214,000-token first request. A real row fixes both: many threads per agent,
-- and a stable id to hang Hermes's own session state off so continuity comes
-- from `session/load` instead of from re-sending the transcript.
--
-- `hermes_session_id` is the ACP session id. Hermes's ACP adapter advertises
-- `load_session` and implements `load_session`/`resume_session`
-- (acp_adapter/server.py:1158-1170, :1456, :1504), so storing it per session
-- is what makes resumption possible.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL,
  agent_id BIGINT NOT NULL,
  -- Optional bindings. A session can be a plain chat (both NULL), scoped to a
  -- project, or scoped to one worktree inside a project.
  project_id BIGINT,
  worktree_id BIGINT,
  title TEXT NOT NULL DEFAULT '',
  -- 'auto' titles may be replaced by the first-message summariser; 'user'
  -- ones never are. Same distinction Hermes's own sessions table draws.
  title_source TEXT NOT NULL DEFAULT 'auto',
  hermes_session_id TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  pinned BOOLEAN NOT NULL DEFAULT false
);

-- The session rail's only query: newest activity first, within a workspace.
CREATE INDEX IF NOT EXISTS chat_sessions_workspace_activity_idx
  ON chat_sessions (workspace_id, last_activity_at DESC);
-- The agent detail page's Sessions tab.
CREATE INDEX IF NOT EXISTS chat_sessions_agent_activity_idx
  ON chat_sessions (agent_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_project_idx ON chat_sessions (project_id)
  WHERE project_id IS NOT NULL;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS session_id BIGINT;
CREATE INDEX IF NOT EXISTS runs_session_idx ON runs (session_id, id)
  WHERE session_id IS NOT NULL;

-- The active-run guard has to learn about sessions, or the whole feature is
-- unusable: every standalone run has `task_id` and `page_id` NULL, so the
-- existing index collapses to "one non-terminal run per agent, ever" — two
-- different sessions using the same agent could not run at the same time.
-- Adding the session as a fourth key column keeps the original guarantees
-- (one active run per task, per page) while making concurrency per SESSION,
-- which is what a user with two open chats expects.
DROP INDEX IF EXISTS runs_task_agent_active_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS runs_task_agent_active_uidx
  ON runs (
    COALESCE(task_id, -1),
    COALESCE(agent_id, -1),
    COALESCE(page_id, -1),
    COALESCE(session_id, -1)
  )
  WHERE status NOT IN ('completed', 'failed', 'cancelled');

-- WORKTREES. A worktree is a checkout of ONE git resource of a project, which
-- is why it points at `project_resources` and not at the project: a project
-- can bind several repos and several plain folders, but `git worktree add`
-- only means anything inside an initialised repository.
--
-- Shape follows Orca's, which is the most battle-tested version of this idea
-- available to read (github.com/stablyai/orca): a durable row carrying the
-- branch, the base ref it was cut from, and a display name, with the path as
-- the natural key. Storing `base_ref` matters — it is what "ahead/behind"
-- and the diff view are computed against, and re-deriving it later from git
-- alone is unreliable once branches move.
CREATE TABLE IF NOT EXISTS worktrees (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  -- 'active' | 'archived' | 'removed'. Rows are kept after removal so a
  -- session that ran in a since-deleted worktree still says where it ran.
  status TEXT NOT NULL DEFAULT 'active',
  created_by_session_id BIGINT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per checkout directory: `git worktree add` fails on an existing
-- path anyway, so the database should not pretend otherwise.
CREATE UNIQUE INDEX IF NOT EXISTS worktrees_path_uidx ON worktrees (path);
CREATE INDEX IF NOT EXISTS worktrees_project_idx ON worktrees (project_id, status);
CREATE INDEX IF NOT EXISTS worktrees_resource_idx ON worktrees (resource_id, status);
