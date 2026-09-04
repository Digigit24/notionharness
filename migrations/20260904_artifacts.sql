-- R8.2 — widening `artifacts` from P2.1 scaffolding into the real artifact
-- record.
--
-- Applied as additive SQL rather than through `payload migrate`, for the same
-- reason every other schema change in this project has been: this database was
-- created by dev-mode push, so Payload's migration runner refuses to touch it.
-- Every statement here is idempotent and safe to re-run.
--
-- This one is NOT purely additive, and that is the whole difficulty. The
-- P2.1 shape has `task_id NOT NULL` and `url NOT NULL`; R8 needs
-- `workspace_id NOT NULL` and both of the old columns optional. A row that
-- exists today has a task and no workspace, so the order below matters:
-- add the column nullable, backfill it from the row's task, and only then
-- tighten it. Doing the tighten first would fail against any existing data.
--
-- Observed state when this was written: `SELECT count(*) FROM artifacts`
-- returned 0, so the backfill is a no-op here. It is written anyway, because
-- the migration has to be correct on any other database this repo is pointed
-- at (a colleague's, a restored dump), and because a backfill that only works
-- on an empty table is not a backfill.
--
-- Select fields are stored as varchar rather than as Postgres enums, matching
-- `runtime_profiles.home_strategy` and `plugins.transport`. Payload reads and
-- writes selects as plain strings, and an enum type would mean a second
-- migration every time an option is added.

-- The tenancy boundary. Nullable at first, on purpose — see the header.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS workspace_id INTEGER
  REFERENCES workspaces(id) ON DELETE CASCADE;

-- 'page' | 'html'. Defaulted to 'page' so a pre-existing row (which pointed
-- at a URL, i.e. content this app does not own) is not silently relabelled
-- as an HTML artifact whose body we would then be expected to render.
-- Those rows keep their `url` and are the reason `url` survives at all.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS kind VARCHAR NOT NULL DEFAULT 'page';

-- kind='page': the artifact is a pointer, the document lives in `pages`.
-- ON DELETE SET NULL rather than CASCADE: deleting the page should leave a
-- visibly broken artifact the human can clear, not silently vanish a row the
-- Artifacts inbox was counting.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS page_id INTEGER
  REFERENCES pages(id) ON DELETE SET NULL;

-- The block id inside `page_id` that a run owns and appends under. Not in the
-- R8.2 field list, but required by R8.5's "the run holds a scoped subtree
-- handle": a run can create several artifacts, so the existing single
-- `runs.page_subtree_block_id` (one per run, already spoken for by the task
-- page) cannot hold it. It belongs per-artifact and nowhere else.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS page_subtree_block_id VARCHAR;

-- kind='html'. TEXT, not VARCHAR(n): an HTML document has no useful length
-- bound, and the write path caps it instead (see lib/artifacts.ts).
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS html_content TEXT;

-- The field the entire R8.3 placement rule turns on. NULL means loose, and
-- loose is exactly what the Artifacts section lists.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS project_id INTEGER
  REFERENCES projects(id) ON DELETE SET NULL;

-- `session` and `run` are NOT foreign keys and NOT Payload relationships.
-- `chat_sessions` and `runs` are broker tables (lib/broker/*), owned by raw
-- pg and deliberately outside Payload's collection set — there is no
-- `sessions`/`runs` collection to relate to. They are plain numbers here, and
-- `numeric` specifically because that is what Payload's `number` field maps
-- to (cf. `pages.position`); using BIGINT would make the physical column
-- disagree with the schema Payload builds from the collection config.
--
-- Note the names: `session`, not `session_id`. Payload only appends `_id` for
-- RELATIONSHIP fields; a `number` field keeps its own name. Getting this
-- wrong is silent until the first insert, which fails with
-- `column "session" of relation "artifacts" does not exist` — which is
-- exactly how it was caught here.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS session NUMERIC;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS run NUMERIC;

-- Which agent authored it, so the list can be filtered by author.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS created_by_agent_id INTEGER
  REFERENCES agents(id) ON DELETE SET NULL;

-- Backfill before tightening. `tasks.workspace_id` is itself NOT NULL, so
-- every row that has a task gets a workspace here.
UPDATE artifacts a
   SET workspace_id = t.workspace_id
  FROM tasks t
 WHERE a.task_id = t.id
   AND a.workspace_id IS NULL;

-- The breaking half of R8.2: `task` becomes optional, and so does `url`.
-- `url` is not in the R8.2 field list at all, but it cannot stay NOT NULL —
-- a page artifact has no URL to store, its address is derived from its page
-- id. Dropping the column instead would destroy the only content reference
-- the P2.1 rows have.
ALTER TABLE artifacts ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE artifacts ALTER COLUMN url DROP NOT NULL;

-- Only now, and only if the backfill actually left no gaps. Guarded rather
-- than unconditional: a row with neither a task nor a workspace (impossible
-- under the P2.1 shape, possible on a database someone has hand-edited)
-- should make this migration report the problem, not abort halfway through
-- and leave the table in a state where re-running it is ambiguous.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM artifacts WHERE workspace_id IS NULL) THEN
    RAISE WARNING 'artifacts.workspace_id left nullable: % row(s) could not be backfilled from their task. Fix those rows, then re-run this migration.',
      (SELECT count(*) FROM artifacts WHERE workspace_id IS NULL);
  ELSE
    ALTER TABLE artifacts ALTER COLUMN workspace_id SET NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS artifacts_workspace_idx ON artifacts (workspace_id);
CREATE INDEX IF NOT EXISTS artifacts_project_idx ON artifacts (project_id);
CREATE INDEX IF NOT EXISTS artifacts_page_idx ON artifacts (page_id);
CREATE INDEX IF NOT EXISTS artifacts_kind_idx ON artifacts (kind);
CREATE INDEX IF NOT EXISTS artifacts_session_idx ON artifacts (session);
CREATE INDEX IF NOT EXISTS artifacts_created_by_agent_idx ON artifacts (created_by_agent_id);

-- The Artifacts section's only query: loose artifacts in one workspace,
-- newest first. A partial index on exactly that predicate, because the whole
-- point of the inbox is that it is short while the table is not.
CREATE INDEX IF NOT EXISTS artifacts_loose_idx
  ON artifacts (workspace_id, created_at DESC)
  WHERE project_id IS NULL;

-- Registering a collection is not only its own table: Payload keeps two
-- internal join tables with one `<collection>_id` column per collection, and
-- a collection missing from either breaks every admin read that touches
-- document locking or preferences (see migrations/20260904_plugins.sql for
-- how that surfaced). Artifacts was registered in payload.config.ts back at
-- P2.1, and `payload_locked_documents_rels.artifacts_id` already exists —
-- but `payload_preferences_rels.artifacts_id` does NOT, which was verified
-- against the live database rather than assumed. Both statements are
-- IF NOT EXISTS, so the one already present is a no-op.
ALTER TABLE payload_locked_documents_rels ADD COLUMN IF NOT EXISTS artifacts_id INTEGER
  REFERENCES artifacts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_artifacts_idx
  ON payload_locked_documents_rels (artifacts_id);

ALTER TABLE payload_preferences_rels ADD COLUMN IF NOT EXISTS artifacts_id INTEGER
  REFERENCES artifacts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS payload_preferences_rels_artifacts_idx
  ON payload_preferences_rels (artifacts_id);
