-- R4.1 — the plugin registry.
--
-- Applied as additive SQL rather than through `payload migrate`, for the same
-- reason every other schema change in this project has been: this database was
-- created by dev-mode push, so Payload's migration runner refuses to touch it.
-- Every statement here is idempotent and additive; nothing existing is altered.
--
-- Select fields are stored as varchar rather than as Postgres enums, matching
-- what `runtime_profiles.home_strategy` already does. Payload reads and writes
-- selects as plain strings, and an enum type would mean a second migration
-- every time an option is added.
CREATE TABLE IF NOT EXISTS plugins (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR NOT NULL,
  workspace_id   INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  description    VARCHAR,
  transport      VARCHAR NOT NULL DEFAULT 'http',
  url            VARCHAR,
  command        VARCHAR,
  args           JSONB DEFAULT '[]'::jsonb,
  headers        JSONB DEFAULT '[]'::jsonb,
  env            JSONB DEFAULT '[]'::jsonb,
  enabled        BOOLEAN DEFAULT true,
  scope          VARCHAR NOT NULL DEFAULT 'agents',
  config_options JSONB DEFAULT '[]'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plugins_workspace_idx ON plugins (workspace_id);

-- Payload stores a hasMany relationship in a sibling `_rels` table, shaped
-- exactly like `workspaces_rels`: one row per link, `path` naming the field.
CREATE TABLE IF NOT EXISTS plugins_rels (
  id        SERIAL PRIMARY KEY,
  "order"   INTEGER,
  parent_id INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  path      VARCHAR NOT NULL,
  agents_id INTEGER REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS plugins_rels_parent_idx ON plugins_rels (parent_id);
CREATE INDEX IF NOT EXISTS plugins_rels_agents_idx ON plugins_rels (agents_id);
