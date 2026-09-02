-- Fixes a NULL-safety gap in `runs_task_agent_active_uidx` (added in 0001).
-- Postgres unique indexes treat NULL as distinct from every other value —
-- including another NULL — so the original plain-column index
-- `(task_id, agent_id) WHERE status NOT IN (...)` never actually enforced
-- "at most one non-terminal run per (task, agent)" for any row where either
-- column is NULL. That's not a theoretical case: every page-scoped run
-- (`app/(app)/actions.ts`'s `enqueueRun` call passes `taskId: null`
-- explicitly, per P6.1/6.2) has `task_id IS NULL` by construction, so two
-- concurrent non-terminal page-scoped runs for the very same agent+page
-- were never blocked by this index at all.
--
-- Rebuild the index on COALESCE(...) sentinels so a NULL column still
-- participates in the uniqueness check. -1 is a safe sentinel: `task_id`/
-- `agent_id`/`page_id` are BIGINT columns referencing BIGSERIAL/serial
-- primary keys, which never assign a negative id.
--
-- `page_id` is added as a third key column alongside the original two, not
-- just `task_id`/`agent_id`. Reasoning:
--   * For page-scoped runs, `task_id` is always NULL (`-1` for all of
--     them) — without `page_id` in the index, this fix would collapse
--     every page-scoped run by the same agent onto one dedup key
--     regardless of which page it's on. Correct behavior is "at most one
--     non-terminal run per (agent, page)", which requires `page_id`.
--   * Task-scoped runs aren't guaranteed to have `page_id IS NULL` either:
--     `app/api/daemon/page-writes/route.ts` lazily calls
--     `setRunPageContext` the first time a task-scoped run's agent writes
--     to a page, stamping that run's own `page_id` in after the fact. This
--     doesn't change the effective dedup key for task-scoped runs in
--     practice — `page_id` there is 1:1 derived from `task_id` via
--     `ensureTaskPage(taskId)`, so two runs sharing a `task_id` still share
--     the same `page_id` once stamped — but it does mean this index can't
--     assume `page_id` is a page-scoped-only column.
--
-- Idempotent for safe restarts, same as every other file in this directory.
DROP INDEX IF EXISTS runs_task_agent_active_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS runs_task_agent_active_uidx
  ON runs (COALESCE(task_id, -1), COALESCE(agent_id, -1), COALESCE(page_id, -1))
  WHERE status NOT IN ('completed', 'failed', 'cancelled');
