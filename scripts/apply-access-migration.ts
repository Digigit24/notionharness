// Applies the access-and-connectors DDL and PROVES the backfill.
//
// `npx payload migrate` does not complete in this environment (it hangs before
// running anything, reproducibly), so the same statements are executed through
// the broker pool. They are plain DDL and every one of them is `IF NOT EXISTS`,
// so running this and later running the Payload migration is safe in either
// order — which is the property that makes doing it this way acceptable rather
// than a shortcut.
//
// The assertions at the end are the point. A migration that creates tables is
// not interesting; a migration that moves every existing person into the new
// membership table WITHOUT anyone losing access is, and that is the only part
// that cannot be checked by reading it.
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const { getBrokerPool, closeBrokerPool } = await import('../lib/broker/db')

const pool = getBrokerPool()

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const DDL = `
CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id" serial PRIMARY KEY,
  "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" varchar NOT NULL DEFAULT 'member',
  "invited_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_unique_idx" ON "workspace_members" ("workspace_id", "user_id");
CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" ("user_id");

CREATE TABLE IF NOT EXISTS "invitations" (
  "id" serial PRIMARY KEY,
  "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "email" varchar NOT NULL,
  "role" varchar NOT NULL DEFAULT 'member',
  "token" varchar NOT NULL,
  "status" varchar NOT NULL DEFAULT 'pending',
  "invited_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "accepted_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at" timestamp(3) with time zone NOT NULL,
  "channel_id" bigint,
  "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_token_idx" ON "invitations" ("token");
CREATE INDEX IF NOT EXISTS "invitations_workspace_idx" ON "invitations" ("workspace_id");
CREATE INDEX IF NOT EXISTS "invitations_email_idx" ON "invitations" ("email");

CREATE TABLE IF NOT EXISTS "access_grants" (
  "id" serial PRIMARY KEY,
  "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "object_type" varchar NOT NULL,
  "object_id" varchar NOT NULL,
  "subject_user_id" integer REFERENCES "users"("id") ON DELETE CASCADE,
  "subject_agent_id" integer REFERENCES "agents"("id") ON DELETE CASCADE,
  "role" varchar NOT NULL DEFAULT 'viewer',
  "granted_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "access_grants_one_subject" CHECK (
    ("subject_user_id" IS NOT NULL AND "subject_agent_id" IS NULL) OR
    ("subject_user_id" IS NULL AND "subject_agent_id" IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS "access_grants_object_idx" ON "access_grants" ("object_type", "object_id");
CREATE INDEX IF NOT EXISTS "access_grants_subject_user_idx" ON "access_grants" ("subject_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "access_grants_unique_user_idx"
  ON "access_grants" ("object_type", "object_id", "subject_user_id") WHERE "subject_user_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "access_grants_unique_agent_idx"
  ON "access_grants" ("object_type", "object_id", "subject_agent_id") WHERE "subject_agent_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "connectors" (
  "id" serial PRIMARY KEY,
  "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" varchar NOT NULL DEFAULT 'composio',
  "toolkit_slug" varchar NOT NULL,
  "name" varchar NOT NULL,
  "scope_type" varchar NOT NULL DEFAULT 'workspace',
  "scope_id" varchar,
  "auth_config_id" varchar,
  "allowed_tools" jsonb DEFAULT '[]'::jsonb,
  "enabled" boolean DEFAULT true,
  "created_by_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "connectors_workspace_idx" ON "connectors" ("workspace_id");
CREATE INDEX IF NOT EXISTS "connectors_scope_idx" ON "connectors" ("scope_type", "scope_id");

CREATE TABLE IF NOT EXISTS "connections" (
  "id" serial PRIMARY KEY,
  "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "toolkit_slug" varchar NOT NULL,
  "composio_connected_account_id" varchar,
  "status" varchar NOT NULL DEFAULT 'pending',
  "status_detail" varchar,
  "redirect_url" varchar,
  "requested_by_run" bigint,
  "last_checked_at" timestamp(3) with time zone,
  "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "connections_unique_idx" ON "connections" ("workspace_id", "user_id", "toolkit_slug");
CREATE INDEX IF NOT EXISTS "connections_account_idx" ON "connections" ("composio_connected_account_id");

ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "composio_api_key" varchar;
`

try {
  await pool.query(DDL)
  console.log('DDL applied.')

  const beforeOwners = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM workspaces WHERE owner_id IS NOT NULL`,
  )
  await pool.query(`
    INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
    SELECT "id", "owner_id", 'owner' FROM "workspaces" WHERE "owner_id" IS NOT NULL
    ON CONFLICT ("workspace_id", "user_id") DO NOTHING;
  `)

  const hasRels = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'workspaces_rels'`,
  )
  if (Number(hasRels.rows[0].n) > 0) {
    await pool.query(`
      INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
      SELECT r."parent_id", r."users_id", 'member'
        FROM "workspaces_rels" r
       WHERE r."path" = 'members' AND r."users_id" IS NOT NULL
      ON CONFLICT ("workspace_id", "user_id") DO NOTHING;
    `)
  }

  // --- the assertions that matter -----------------------------------------
  const owners = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM workspace_members WHERE role = 'owner'`,
  )
  check(
    'every workspace owner has an owner row',
    Number(owners.rows[0].n) >= Number(beforeOwners.rows[0].n),
    `${owners.rows[0].n} owner rows for ${beforeOwners.rows[0].n} owned workspaces`,
  )

  const orphaned = await pool.query<{ n: string }>(`
    SELECT count(*) AS n FROM workspaces w
     WHERE w.owner_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = w.owner_id
       )
  `)
  check('no owner was left out of their own workspace', Number(orphaned.rows[0].n) === 0, `${orphaned.rows[0].n} missing`)

  if (Number(hasRels.rows[0].n) > 0) {
    const missingMembers = await pool.query<{ n: string }>(`
      SELECT count(*) AS n FROM workspaces_rels r
       WHERE r.path = 'members' AND r.users_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM workspace_members m WHERE m.workspace_id = r.parent_id AND m.user_id = r.users_id
         )
    `)
    check(
      'every legacy member was carried over',
      Number(missingMembers.rows[0].n) === 0,
      `${missingMembers.rows[0].n} not carried`,
    )
  }

  const dupes = await pool.query<{ n: string }>(`
    SELECT count(*) AS n FROM (
      SELECT workspace_id, user_id FROM workspace_members GROUP BY 1, 2 HAVING count(*) > 1
    ) d
  `)
  check('nobody has two roles in one workspace', Number(dupes.rows[0].n) === 0)

  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
     WHERE table_name IN ('workspace_members','invitations','access_grants','connectors','connections')
  `)
  check('all five tables exist', tables.rows.length === 5, tables.rows.map((r) => r.table_name).join(', '))

  const rows = await pool.query<{ workspace_id: number; user_id: number; role: string }>(
    `SELECT workspace_id, user_id, role FROM workspace_members ORDER BY workspace_id, user_id`,
  )
  console.log('')
  console.log('membership after backfill:')
  for (const row of rows.rows) console.log(`  workspace ${row.workspace_id}: user ${row.user_id} = ${row.role}`)
} finally {
  await closeBrokerPool()
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
