-- Raw-pg-owned broker schema — NOT a Payload migration.
--
-- Per AGENTS.md's D5 section: Payload owns workspace tables (collections/*);
-- these three tables are raw `pg` because the broker's CLAIM operation needs
-- `SELECT ... FOR UPDATE SKIP LOCKED` semantics Payload's ORM doesn't expose.
-- Applied by hand via `lib/broker/migrations/apply.ts`, never through
-- `payload migrate` — Payload has no awareness of these tables and must stay
-- that way (see docs/ROADMAP.html Pillar 4.3, and the D5 row in AGENTS.md).
--
-- Idempotent: every statement is safe to re-run (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS runs (
  id BIGSERIAL PRIMARY KEY,

  -- `tasks`/`agents` (Payload collections, per docs/ROADMAP.html 2.1/3.5)
  -- don't exist yet — nullable, no FK constraint until they land. Tighten
  -- these into real FKs once those collections are built.
  task_id BIGINT,
  agent_id BIGINT,

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'dispatched', 'running', 'waiting_directory', 'completed', 'failed', 'cancelled')),

  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  -- Set on the *new* run created by a retry (roadmap 4.3 SETTLE: "retryable
  -- failure + attempt < max -> new run, retry_of set, attribution inherited").
  retry_of BIGINT REFERENCES runs (id),
  priority INTEGER NOT NULL DEFAULT 0,

  -- Two-column attribution (docs/ROADMAP.html 4.7) — never collapse these.
  -- originator_user: "whose authority" — used only for authz. Nullable:
  -- an automation-triggered run (roadmap 7.4) has no originator, only an
  -- accountable_user (the rule owner).
  originator_user INTEGER REFERENCES users (id),
  -- accountable_user: "whose budget and audit trail" — never consulted for
  -- authz. Always present.
  accountable_user INTEGER NOT NULL REFERENCES users (id),

  -- Which daemon/host currently holds (or last held) this run's lease.
  worker_id TEXT,
  -- The ACP session id (RunEvent's `session` event) — "pin immediately,
  -- before the run can crash" per roadmap 3.2.
  external_session_id TEXT,

  -- Monotonic counter for this run's own run_messages.seq. Incremented
  -- atomically (`UPDATE ... SET next_seq = next_seq + 1 RETURNING next_seq`)
  -- in the same statement as each run_messages insert, so seq assignment
  -- and the row it labels are never split across a race.
  next_seq BIGINT NOT NULL DEFAULT 0,

  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  error TEXT,
  -- Per-run MCP server overlay (roadmap 4.7) — wiped (set NULL) on settle so
  -- a live bearer token never lingers in a settled row.
  mcp_overlay JSONB,
  -- Short-lived credential reference (roadmap 4.7) — revoked (set NULL) on
  -- settle, same reasoning as mcp_overlay.
  run_token TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Roadmap 4.3 ENQUEUE: "blocked by a partial unique index: at most one
-- non-terminal run per (task, agent)". NULLs are distinct in a unique index
-- (standard Postgres behaviour), so this is inert until task_id/agent_id are
-- actually populated — which is fine, nothing populates them yet either.
CREATE UNIQUE INDEX IF NOT EXISTS runs_task_agent_active_uidx
  ON runs (task_id, agent_id)
  WHERE status NOT IN ('completed', 'failed', 'cancelled');

-- Roadmap 4.3 CLAIM: "ORDER BY priority DESC, created_at ASC" over queued rows.
CREATE INDEX IF NOT EXISTS runs_claim_idx
  ON runs (priority DESC, created_at ASC)
  WHERE status = 'queued';

-- Roadmap 4.3 RECOVER: sweeper scans non-terminal runs for an expired lease.
CREATE INDEX IF NOT EXISTS runs_lease_sweep_idx
  ON runs (lease_expires_at)
  WHERE status IN ('dispatched', 'running');

CREATE TABLE IF NOT EXISTS run_messages (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  -- Assigned from runs.next_seq at append time — never from a timestamp or
  -- insertion order (roadmap 3.1: batched inserts return unordered, "the bug
  -- that silently scrambles transcripts").
  seq BIGINT NOT NULL,
  -- The discriminated RunEvent union (docs/ROADMAP.html 3.1) verbatim:
  -- {type:'message'|'thought'|'tool_call'|'tool_result'|'permission'|
  --  'file_change'|'terminal'|'usage'|'session'|'done', ...}.
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS run_messages_run_id_seq_idx ON run_messages (run_id, seq);

CREATE TABLE IF NOT EXISTS run_usage (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  provider TEXT,
  model TEXT,
  tokens BIGINT,
  cost_ticks BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_usage_run_id_idx ON run_usage (run_id);
